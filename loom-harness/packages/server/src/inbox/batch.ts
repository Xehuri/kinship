/**
 * T4 收件箱批量生命周期：从 prompt 标记认领批次，在 run 收尾做 ack/FYI 自动回执/重投/死信。
 *
 * 挂点（session-api registry）：
 *   - 每轮 #start 起跑前 onPrompt(sessionID, text) 返回 run-scoped token；
 *   - #start finally 在 #drainQueue 之前 onRunFinished(sessionID, token)。
 * 崩溃语义：
 *   - 认领结果只在内存；账本里的 delivered/attempts/batch_id 是重启后的真源。
 *   - 重启不自动重投 action letter（避免重复）；routed-without-delivered 只告警并保持可见。
 *
 * 重投口径（与 docs/dev/loom-inbox-contract.md §5 对齐）：
 *   - attempts = 已投递次数（首投 = 1，每次 redelivered +1）；
 *   - redelivery.maxAttempts = 允许的重投次数（缺省 1 = 首投 + 一次重投）；
 *   - ackGraceTurns = 未 ack 信件可存活的投递轮数上限（缺省 2）；
 *   - 可重投当且仅当 attempts <= maxAttempts 且 attempts < ackGraceTurns；
 *     否则写 dead_letter（reason=unacked_at_run_end）。
 */

import { randomUUID } from "node:crypto";

import type { InboxConfig } from "../config/section-checks.js";
import {
  DEFAULT_ACK_GRACE_TURNS,
  DEFAULT_REDELIVERY_BACKOFF_MS,
  DEFAULT_REDELIVERY_MAX_ATTEMPTS,
} from "./defaults.js";
import type { InboxJournalStore } from "./journal-store.js";
import type { InboxLog } from "./router.js";
import type { LetterRecord, LetterState } from "./types.js";

const BATCH_MARKER = /\[loom-inbox:batch=([^\]\s]+)\]/;
const LETTER_MARKER = /\[loom-inbox:letter=([^\]\s]+)\]/g;
const INCLUDED_IDS_LINE = /^included_ids:\s*(.*)$/m;

const TERMINAL_STATES: ReadonlySet<LetterState> = new Set([
  "acked",
  "expired",
  "dead_letter",
  "observed",
]);

export interface InboxPromptMarkers {
  readonly batchId?: string;
  readonly letterIds: readonly string[];
  readonly includedIds: readonly string[];
}

export interface InboxBatchToken {
  readonly kind: "loom.inbox.batch";
  readonly tokenId: string;
  readonly sessionID: string;
  readonly batchId?: string;
  readonly letterIds: readonly string[];
  readonly claimedAt: number;
}

export interface InboxBatchRuntimeOptions {
  readonly store: InboxJournalStore;
  readonly config: InboxConfig;
  readonly sessionID: string;
  readonly deliverWake: (line: string) => void;
  readonly now?: () => number;
  readonly log?: InboxLog;
  /** 测试注入：默认 setTimeout；生产不替换。 */
  readonly schedule?: (run: () => void, delayMs: number) => () => void;
}

interface InternalToken extends InboxBatchToken {
  readonly key: string;
}

export function parseInboxPromptMarkers(text: string): InboxPromptMarkers {
  const batchId = BATCH_MARKER.exec(text)?.[1];
  const letterIds: string[] = [];
  for (const match of text.matchAll(LETTER_MARKER)) {
    const id = match[1];
    if (id !== undefined) letterIds.push(id);
  }
  const includedRaw = INCLUDED_IDS_LINE.exec(text)?.[1]?.trim() ?? "";
  const includedIds =
    includedRaw.length === 0 || includedRaw === "(none)"
      ? []
      : includedRaw
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0);
  return {
    ...(batchId === undefined ? {} : { batchId }),
    letterIds: [...new Set(letterIds)],
    includedIds: [...new Set(includedIds)],
  };
}

export class InboxBatchRuntime {
  readonly #store: InboxJournalStore;
  readonly #sessionID: string;
  readonly #deliverWake: (line: string) => void;
  readonly #now: () => number;
  readonly #log: InboxLog | undefined;
  readonly #schedule: (run: () => void, delayMs: number) => () => void;
  readonly #autoAckKinds: ReadonlySet<string>;
  readonly #maxAttempts: number;
  readonly #backoffMs: number;
  readonly #ackGraceTurns: number;
  readonly #tokens = new Map<string, InternalToken>();
  readonly #activeKeys = new Map<string, string>();
  readonly #cancelTimers = new Set<() => void>();

  constructor(options: InboxBatchRuntimeOptions) {
    this.#store = options.store;
    this.#sessionID = options.sessionID;
    this.#deliverWake = options.deliverWake;
    this.#now = options.now ?? Date.now;
    this.#log = options.log;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#autoAckKinds = new Set(options.config.autoAckKinds ?? []);
    this.#maxAttempts =
      options.config.redelivery?.maxAttempts ?? DEFAULT_REDELIVERY_MAX_ATTEMPTS;
    this.#backoffMs = options.config.redelivery?.backoffMs ?? DEFAULT_REDELIVERY_BACKOFF_MS;
    this.#ackGraceTurns = options.config.ackGraceTurns ?? DEFAULT_ACK_GRACE_TURNS;
  }

  /** #start 起跑前调用；非 inbox 会话 / 无标记 = undefined（不动任何状态）。 */
  onPrompt(sessionID: string, text: string): InboxBatchToken | undefined {
    if (sessionID !== this.#sessionID) return undefined;
    try {
      const markers = parseInboxPromptMarkers(text);
      const ids = this.#resolveIds(markers);
      if (ids.length === 0) return undefined;
      const key = markerKey(markers, ids);
      const activeId = this.#activeKeys.get(key);
      if (activeId !== undefined) {
        const active = this.#tokens.get(activeId);
        if (active !== undefined) return active;
        this.#activeKeys.delete(key);
      }
      const token: InternalToken = {
        kind: "loom.inbox.batch",
        tokenId: randomUUID(),
        sessionID,
        ...(markers.batchId === undefined ? {} : { batchId: markers.batchId }),
        letterIds: ids,
        claimedAt: this.#now(),
        key,
      };
      this.#tokens.set(token.tokenId, token);
      this.#activeKeys.set(key, token.tokenId);
      return token;
    } catch (error: unknown) {
      this.#warn("loom inbox batch claim failed", {
        error: errorMessage(error),
      });
      return undefined;
    }
  }

  /** #start finally 在 #drainQueue 之前调用；绝不抛出。 */
  onRunFinished(sessionID: string, token: unknown): void {
    if (sessionID !== this.#sessionID) return;
    if (!isBatchToken(token)) return;
    const entry = this.#tokens.get(token.tokenId);
    if (entry === undefined || entry !== token) return;
    this.#tokens.delete(token.tokenId);
    this.#activeKeys.delete(entry.key);

    const now = this.#now();
    for (const id of entry.letterIds) {
      try {
        this.#finishLetter(id, now);
      } catch (error: unknown) {
        this.#warn("loom inbox batch finish failed", {
          letterID: id,
          error: errorMessage(error),
        });
      }
    }
  }

  dispose(): void {
    for (const cancel of [...this.#cancelTimers]) {
      cancel();
    }
    this.#cancelTimers.clear();
  }

  #resolveIds(markers: InboxPromptMarkers): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    const add = (candidate: string): void => {
      if (seen.has(candidate)) return;
      if (this.#store.get(candidate) === undefined) return;
      seen.add(candidate);
      ids.push(candidate);
    };
    if (markers.batchId !== undefined) {
      for (const record of this.#store.list()) {
        if (record.batch_id === markers.batchId) add(record.id);
      }
    }
    for (const id of markers.includedIds) add(id);
    for (const id of markers.letterIds) add(id);
    return ids;
  }

  #finishLetter(id: string, now: number): void {
    const record = this.#store.get(id);
    if (record === undefined) return;
    if (TERMINAL_STATES.has(record.state)) return;

    if (this.#autoAckKinds.has(record.kind)) {
      this.#store.appendEvent({
        schema: 1,
        event: "letter.acked",
        at: now,
        id,
        acked_at: now,
        ack_outcome: "no_action",
      });
      return;
    }

    if (
      record.state === "deferred" &&
      record.deferred_until !== undefined &&
      record.deferred_until > now
    ) {
      return;
    }

    if (this.#canRedeliver(record)) {
      const attempts = record.attempts + 1;
      this.#store.appendEvent({
        schema: 1,
        event: "letter.redelivered",
        at: now,
        id,
        attempts,
      });
      this.#scheduleReminder(id, attempts);
      return;
    }

    this.#store.appendEvent({
      schema: 1,
      event: "letter.dead_letter",
      at: now,
      id,
      reason: "unacked_at_run_end",
    });
  }

  #canRedeliver(record: LetterRecord): boolean {
    return record.attempts <= this.#maxAttempts && record.attempts < this.#ackGraceTurns;
  }

  #scheduleReminder(id: string, attempt: number): void {
    const line =
      `[loom-inbox:letter=${id}] 收件箱来信尚未处理（第 ${String(attempt)} 次投递）。` +
      "请处理后调用 inbox_ack 回执；FYI 类可按 inbox.autoAckKinds 自动回执。";
    let cancel: (() => void) | undefined;
    const fire = (): void => {
      if (cancel !== undefined) this.#cancelTimers.delete(cancel);
      try {
        this.#deliverWake(line);
      } catch (error: unknown) {
        this.#warn("loom inbox redelivery wake failed", {
          letterID: id,
          error: errorMessage(error),
        });
      }
    };
    cancel = this.#schedule(fire, Math.max(0, this.#backoffMs));
    this.#cancelTimers.add(cancel);
  }

  #warn(msg: string, fields: Record<string, unknown>): void {
    this.#log?.("warn", msg, fields);
  }
}

function markerKey(markers: InboxPromptMarkers, ids: readonly string[]): string {
  if (markers.batchId !== undefined) return `batch:${markers.batchId}`;
  return `letters:${ids.join(",")}`;
}

function isBatchToken(value: unknown): value is InboxBatchToken {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record["kind"] === "loom.inbox.batch" &&
    typeof record["tokenId"] === "string" &&
    typeof record["sessionID"] === "string" &&
    Array.isArray(record["letterIds"])
  );
}

function defaultSchedule(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
