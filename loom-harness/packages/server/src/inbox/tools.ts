/**
 * T4 收件箱模型面（pull tools）：inbox_list / inbox_read / inbox_ack / inbox_defer。
 *
 * 边界：
 *   - 仅配置的 inbox 主会话可用；child/side 面不装配本组工具（tool-wiring.mainOnlyTools），
 *     这里的 sessionId 守卫是防御纵深，不是主门。
 *   - class 是唯一契约；本文件不输出、不计算、不记录数值权重。
 *   - 除 inbox_read 外绝不返回正文；错误/日志只带 letter id 与字段名。
 *   - 账本唯一真源仍是 InboxJournalStore；本文件只 append 生命周期事件，不建第二队列/DB。
 */

import { Type } from "@axeuh/loom-core";
import type { HarnessTool, HookContext, ToolExecResult } from "@axeuh/loom-core";

import type { InboxConfig } from "../config/section-checks.js";
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_THREAD_ID_CHARS,
  DEFAULT_MAX_THREAD_KIND_CHARS,
} from "./defaults.js";
import type { InboxJournalStore } from "./journal-store.js";
import {
  compareLettersOldestFirst,
  summarizeThreads,
  threadDisplayName,
  threadIdOf,
  threadKind,
} from "./thread.js";
import { UNREAD_LETTER_STATES, type LetterRecord, type LetterState } from "./types.js";
import { THREAD_KIND_RE } from "./validate.js";

const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 50;
const READ_MAX_IDS = 20;
const THREAD_READ_DEFAULT_LIMIT = 20;
const THREAD_READ_MAX_LIMIT = 50;
const READ_MAX_BODY_BYTES = 64 * 1024;
const MUTATE_MAX_IDS = 50;
const MAX_DEFERS_PER_LETTER = 3;
const MAX_DEFER_MS = 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_CHARS = 1024;
const MAX_NOTE_CHARS = 2048;

/** 线程批量读的口径：默认未读；include_read 只额外放开 read，终态永不可读。 */
const THREAD_READ_STATES: ReadonlySet<LetterState> = new Set([
  ...UNREAD_LETTER_STATES,
  "read",
]);

const ACK_OUTCOMES = ["replied", "acted", "deferred", "no_action", "failed"] as const;
type AckOutcome = (typeof ACK_OUTCOMES)[number];

export interface InboxToolsOptions {
  readonly store: InboxJournalStore;
  readonly config: InboxConfig;
  /** 配置的 inbox 主会话 id；任何其他 ctx.sessionId 一律拒绝。 */
  readonly sessionID: string;
  readonly now?: () => number;
  /** defer 后触发既有 digest reconcile（fail-soft；缺省不触发）。 */
  readonly onDeferred?: () => void | Promise<void>;
}

export function createInboxTools(options: InboxToolsOptions): readonly HarnessTool[] {
  const nowOf = options.now ?? Date.now;
  const autoAckKinds = new Set(options.config.autoAckKinds ?? []);

  function assertMainSession(tool: string, ctx: HookContext): void {
    if (ctx.sessionId !== options.sessionID) {
      throw new Error(
        `${tool} is only available to the configured inbox main session`,
      );
    }
  }

  function isActionKind(record: LetterRecord): boolean {
    return !autoAckKinds.has(record.kind);
  }

  const listTool: HarnessTool = {
    name: "inbox_list",
    description:
      "Mailbox overview grouped by conversation thread (metadata only, never bodies or letter ids). " +
      "Only threads with unread letters (pending/routed/delivered/deferred) appear. Filter by " +
      "source and thread_kind. Returns as_of, total_unread, and per-thread " +
      "{source, thread_id, thread_name, thread_kind, unread, latest_at, oldest_unread_at}, " +
      "sorted by latest_at desc and capped to limit (truncated=true when more threads exist). " +
      "Use inbox_read with source+thread_id to fetch a thread's full letter bodies.",
    parameters: Type.Object({
      source: Type.Optional(Type.String({ description: "Registered source key." })),
      thread_kind: Type.Optional(
        Type.String({
          description:
            "Thread kind filter, e.g. group | contact | dm | comment | mention | issue | pr | notification | task.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: LIST_MAX_LIMIT,
          description: `Maximum threads to return (default ${String(LIST_DEFAULT_LIMIT)}, max ${String(LIST_MAX_LIMIT)}).`,
        }),
      ),
    }),
    isConcurrencySafe: () => true,
    async execute(args, ctx): Promise<ToolExecResult> {
      assertMainSession("inbox_list", ctx);
      const source = optionalNonEmptyString(args.source, "source");
      const kind = parseThreadKindFilter(args.thread_kind);
      const limit = clampInteger(args.limit, LIST_DEFAULT_LIMIT, 1, LIST_MAX_LIMIT, "limit");
      const records = options.store.list(source === undefined ? {} : { source });
      const threads = summarizeThreads(records, kind);
      const totalUnread = threads.reduce((sum, thread) => sum + thread.unread, 0);
      const page = threads.slice(0, limit);
      return textResult({
        as_of: nowOf(),
        total_unread: totalUnread,
        threads: page,
        truncated: threads.length > page.length,
      });
    },
  };

  const readTool: HarnessTool = {
    name: "inbox_read",
    description:
      "Read full letter bodies either by ids (max 20) or by one thread (source+thread_id, oldest " +
      "first, limit default 20/max 50). Bodies are capped at 64KB with a truncated flag. " +
      "Thread mode returns only unread letters (pending/routed/delivered/deferred) unless " +
      "include_read=true (adds read; terminal states are never returned). Each body is marked " +
      "letter.read when mark_read=true (default) but never acked. Unknown ids reject the whole " +
      "call before any read marker is written. After acting on an action letter you MUST call " +
      "inbox_ack with evidence_ref.",
    parameters: Type.Object({
      ids: Type.Optional(
        Type.Array(Type.String(), {
          minItems: 1,
          maxItems: READ_MAX_IDS,
          description: `Letter ids to read (max ${String(READ_MAX_IDS)}).`,
        }),
      ),
      thread_id: Type.Optional(
        Type.String({
          maxLength: DEFAULT_MAX_THREAD_ID_CHARS,
          description: "Thread id for batch read; requires source and cannot be combined with ids.",
        }),
      ),
      source: Type.Optional(
        Type.String({ description: "Registered source key for the thread; requires thread_id." }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: THREAD_READ_MAX_LIMIT,
          description: `Maximum thread letters to return (default ${String(THREAD_READ_DEFAULT_LIMIT)}, max ${String(THREAD_READ_MAX_LIMIT)}).`,
        }),
      ),
      include_read: Type.Optional(
        Type.Boolean({ description: "Thread mode: include already-read letters (default false)." }),
      ),
      mark_read: Type.Optional(
        Type.Boolean({ description: "Mark returned unread letters as read (default true)." }),
      ),
    }),
    isConcurrencySafe: () => false,
    async execute(args, ctx): Promise<ToolExecResult> {
      assertMainSession("inbox_read", ctx);
      const threadId = parseThreadIdSelector(args.thread_id);
      const source = optionalNonEmptyString(args.source, "source");
      const includeRead = parseBoolean(args.include_read, "include_read", false);
      const markRead = parseBoolean(args.mark_read, "mark_read", true);
      const limit = clampInteger(
        args.limit,
        THREAD_READ_DEFAULT_LIMIT,
        1,
        THREAD_READ_MAX_LIMIT,
        "limit",
      );
      const now = nowOf();

      if (args.ids !== undefined) {
        if (threadId !== undefined || source !== undefined) {
          throw new Error("inbox_read: ids cannot be combined with source/thread_id");
        }
        const ids = parseIds(args.ids, READ_MAX_IDS, "ids");
        const records = requireRecords(options.store, ids, "inbox_read");
        if (markRead) markRecordsRead(options.store, records, now);
        return textResult({
          letters: records.map((record) => letterWithBody(options.store, record)),
          truncated: false,
          remaining: 0,
        });
      }

      if (threadId === undefined || source === undefined) {
        throw new Error("inbox_read: provide ids, or both source and thread_id");
      }

      const states = includeRead ? THREAD_READ_STATES : UNREAD_LETTER_STATES;
      const matched = options.store
        .list({ source })
        .filter((record) => threadIdOf(record) === threadId && states.has(record.state))
        .sort(compareLettersOldestFirst);
      const page = matched.slice(0, limit);
      if (markRead) markRecordsRead(options.store, page, now);
      return textResult({
        source,
        thread_id: threadId,
        letters: page.map((record) => letterWithBody(options.store, record)),
        truncated: matched.length > page.length,
        remaining: matched.length - page.length,
      });
    },
  };

  const ackTool: HarnessTool = {
    name: "inbox_ack",
    description:
      "Acknowledge up to 50 inbox letters. Per-letter idempotent: already-acked ids return " +
      "already_acked without new events. Action letters (kind not in inbox.autoAckKinds) require " +
      "a non-empty evidence_ref; FYI kinds do not. outcome = replied | acted | deferred | " +
      "no_action | failed. Unknown ids reject the whole call with no partial mutation.",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: MUTATE_MAX_IDS,
        description: `Letter ids to acknowledge (max ${String(MUTATE_MAX_IDS)}).`,
      }),
      outcome: Type.Union(
        [
          Type.Literal("replied"),
          Type.Literal("acted"),
          Type.Literal("deferred"),
          Type.Literal("no_action"),
          Type.Literal("failed"),
        ],
        { description: "replied | acted | deferred | no_action | failed." },
      ),
      evidence_ref: Type.Optional(
        Type.String({
          maxLength: MAX_EVIDENCE_CHARS,
          description: "Required for action letters: where the handling evidence lives.",
        }),
      ),
      note: Type.Optional(
        Type.String({ maxLength: MAX_NOTE_CHARS, description: "Optional short ack note." }),
      ),
    }),
    isConcurrencySafe: () => false,
    async execute(args, ctx): Promise<ToolExecResult> {
      assertMainSession("inbox_ack", ctx);
      const ids = parseIds(args.ids, MUTATE_MAX_IDS, "ids");
      const outcome = parseAckOutcome(args.outcome);
      const evidenceRef = optionalBoundedString(args.evidence_ref, "evidence_ref", MAX_EVIDENCE_CHARS);
      const note = optionalBoundedString(args.note, "note", MAX_NOTE_CHARS);
      const records = requireRecords(options.store, ids, "inbox_ack");

      const missingEvidence = records.filter(
        (record) =>
          record.state !== "acked" &&
          isActionKind(record) &&
          (evidenceRef === undefined || evidenceRef.length === 0),
      );
      if (missingEvidence.length > 0) {
        throw new Error(
          `inbox_ack: action letter(s) require a non-empty evidence_ref: ${missingEvidence
            .map((record) => record.id)
            .join(", ")}`,
        );
      }

      const now = nowOf();
      const results: Array<Record<string, unknown>> = [];
      for (const record of records) {
        if (record.state === "acked") {
          results.push({
            id: record.id,
            status: "already_acked",
            ack_outcome: record.ack_outcome ?? null,
          });
          continue;
        }
        options.store.appendEvent({
          schema: 1,
          event: "letter.acked",
          at: now,
          id: record.id,
          acked_at: now,
          ack_outcome: outcome,
          ...(evidenceRef === undefined || evidenceRef.length === 0
            ? {}
            : { evidence_ref: evidenceRef }),
          ...(note === undefined || note.length === 0 ? {} : { note }),
        });
        results.push({ id: record.id, status: "acked", ack_outcome: outcome });
      }
      return textResult({ acked: results.filter((r) => r.status === "acked").length, results });
    },
  };

  const deferTool: HarnessTool = {
    name: "inbox_defer",
    description:
      "Defer up to 50 inbox letters until an ISO-8601 timestamp or epoch milliseconds. " +
      "Maximum 3 defers per letter and at most 24h ahead. Unknown ids reject the whole call. " +
      "Deferred letters stay pending and are skipped by run-end redelivery until due.",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: MUTATE_MAX_IDS,
        description: `Letter ids to defer (max ${String(MUTATE_MAX_IDS)}).`,
      }),
      until: Type.Union([Type.String(), Type.Number()], {
        description: "ISO-8601 string or epoch milliseconds.",
      }),
      reason: Type.Optional(
        Type.String({ maxLength: MAX_NOTE_CHARS, description: "Optional short reason." }),
      ),
    }),
    isConcurrencySafe: () => false,
    async execute(args, ctx): Promise<ToolExecResult> {
      assertMainSession("inbox_defer", ctx);
      const ids = parseIds(args.ids, MUTATE_MAX_IDS, "ids");
      const now = nowOf();
      const until = parseUntil(args.until, now);
      optionalBoundedString(args.reason, "reason", MAX_NOTE_CHARS);
      const records = requireRecords(options.store, ids, "inbox_defer");

      for (const record of records) {
        if (
          record.state === "acked" ||
          record.state === "expired" ||
          record.state === "dead_letter" ||
          record.state === "observed"
        ) {
          throw new Error(
            `inbox_defer: letter ${record.id} is in terminal state ${record.state}`,
          );
        }
        if (record.defer_count >= MAX_DEFERS_PER_LETTER) {
          throw new Error(
            `inbox_defer: letter ${record.id} reached the ${String(MAX_DEFERS_PER_LETTER)}-defer limit`,
          );
        }
      }

      for (const record of records) {
        options.store.appendEvent({
          schema: 1,
          event: "letter.deferred",
          at: now,
          id: record.id,
          deferred_until: until,
        });
      }
      if (options.onDeferred !== undefined) {
        try {
          await options.onDeferred();
        } catch {
          // deferred 已落账；摘要重排是派生动作，失败绝不回滚账本。
        }
      }
      return textResult({
        deferred: records.map((record) => ({
          id: record.id,
          state: options.store.get(record.id)?.state ?? "deferred",
          deferred_until: until,
          defer_count: options.store.get(record.id)?.defer_count ?? 0,
        })),
      });
    },
  };

  return [listTool, readTool, ackTool, deferTool];
}

function metadataOf(record: LetterRecord): Record<string, unknown> {
  return {
    id: record.id,
    source: record.source,
    kind: record.kind,
    class: record.class,
    trust: record.trust,
    state: record.state,
    created_at: record.created_at,
    attempts: record.attempts,
    title: record.title ?? null,
    thread_id: threadIdOf(record),
    thread_name: threadDisplayName(record),
    thread_kind: threadKind(record),
  };
}

function letterWithBody(
  store: InboxJournalStore,
  record: LetterRecord,
): Record<string, unknown> {
  const current = store.get(record.id) ?? record;
  const body = truncateUtf8(record.body, READ_MAX_BODY_BYTES);
  return {
    ...metadataOf(current),
    body: body.text,
    truncated: body.truncated,
  };
}

function markRecordsRead(
  store: InboxJournalStore,
  records: readonly LetterRecord[],
  now: number,
): void {
  for (const record of records) {
    if (!UNREAD_LETTER_STATES.has(record.state)) continue;
    store.appendEvent({
      schema: 1,
      event: "letter.read",
      at: now,
      id: record.id,
      read_at: now,
    });
  }
}

function parseThreadKindFilter(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Array.from(value).length > DEFAULT_MAX_THREAD_KIND_CHARS ||
    !THREAD_KIND_RE.test(value)
  ) {
    throw new Error(
      `inbox_list: thread_kind must match ${String(THREAD_KIND_RE)} with at most ${String(DEFAULT_MAX_THREAD_KIND_CHARS)} characters`,
    );
  }
  return value;
}

function parseThreadIdSelector(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("thread_id must be a non-empty string");
  }
  if (Array.from(value).length > DEFAULT_MAX_THREAD_ID_CHARS) {
    throw new Error(
      `thread_id must be at most ${String(DEFAULT_MAX_THREAD_ID_CHARS)} characters`,
    );
  }
  return value;
}

function parseBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function parseAckOutcome(value: unknown): AckOutcome {
  if (typeof value === "string" && (ACK_OUTCOMES as readonly string[]).includes(value)) {
    return value as AckOutcome;
  }
  throw new Error(`inbox_ack: outcome must be one of ${ACK_OUTCOMES.join("|")}`);
}

function parseIds(value: unknown, max: number, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array of letter ids`);
  }
  if (value.length > max) {
    throw new Error(`${field} must contain at most ${String(max)} letter ids`);
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${field} entries must be non-empty strings`);
    }
    const id = entry.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function requireRecords(
  store: InboxJournalStore,
  ids: readonly string[],
  tool: string,
): LetterRecord[] {
  const records: LetterRecord[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const record = store.get(id);
    if (record === undefined) unknown.push(id);
    else records.push(record);
  }
  if (unknown.length > 0) {
    throw new Error(`${tool}: unknown letter id(s): ${unknown.join(", ")}`);
  }
  return records;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalBoundedString(
  value: unknown,
  field: string,
  maxChars: number,
): string | undefined {
  const text = optionalNonEmptyString(value, field);
  if (text !== undefined && text.length > maxChars) {
    throw new Error(`${field} must be at most ${String(maxChars)} characters`);
  }
  return text;
}

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function parseUntil(value: unknown, now: number): number {
  let until: number;
  if (typeof value === "number") {
    until = value;
  } else if (typeof value === "string" && value.trim().length > 0) {
    const text = value.trim();
    until = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
  } else {
    throw new Error("until must be an ISO-8601 string or epoch milliseconds");
  }
  if (!Number.isFinite(until)) {
    throw new Error("until must be an ISO-8601 string or epoch milliseconds");
  }
  if (until <= now) {
    throw new Error("until must be in the future");
  }
  if (until > now + MAX_DEFER_MS) {
    throw new Error(`until must be at most ${String(MAX_DEFER_MS)}ms (24h) ahead`);
  }
  return Math.trunc(until);
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }
  let out = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  if (out.endsWith("\uFFFD")) out = out.slice(0, -1);
  return { text: out, truncated: true };
}

function textResult(payload: unknown): ToolExecResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** 读取上限与 store 入账上限解耦：list/read 不改变账本校验口径。 */
export const INBOX_TOOL_LIMITS = {
  listDefaultLimit: LIST_DEFAULT_LIMIT,
  listMaxLimit: LIST_MAX_LIMIT,
  readMaxIds: READ_MAX_IDS,
  threadReadDefaultLimit: THREAD_READ_DEFAULT_LIMIT,
  threadReadMaxLimit: THREAD_READ_MAX_LIMIT,
  readMaxBodyBytes: READ_MAX_BODY_BYTES,
  mutateMaxIds: MUTATE_MAX_IDS,
  maxDefersPerLetter: MAX_DEFERS_PER_LETTER,
  maxDeferMs: MAX_DEFER_MS,
  maxNoteChars: MAX_NOTE_CHARS,
  maxEvidenceChars: MAX_EVIDENCE_CHARS,
  storeMaxBodyBytes: DEFAULT_MAX_BODY_BYTES,
} as const;
