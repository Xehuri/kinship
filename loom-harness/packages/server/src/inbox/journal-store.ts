/**
 * 收件箱事件账本（append-only JSONL）。
 *
 * 文件：`<stateRoot>/inbox/<sessionId>.jsonl`，经 StateLayout.openJournal 打开。
 * 这是账本，不是第二队列：没有 scheduler、没有数据库、没有内存定时器；
 * 所有状态（letters / dedupe TTL / coalesce 窗口 / 速率窗口 / snapshot）都由 replay 得出。
 *
 * 崩溃语义复用 Journal：
 *   - 尾部撕裂行容忍（丢弃并由 Journal 截断修复），通过 onTornTail 回调上报；
 *   - 中段坏行 = 真损坏，抛 StateCorruptionError；
 *   - 未知事件类型 = 语义损坏，抛 InboxJournalError（即使在尾行也不静默丢弃）。
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import {
  type JsonObjectRow,
  Journal,
  StateLayout,
  isJsonObjectRow,
} from "@axeuh/loom-adapters";

import {
  LETTER_CLASSES,
  LETTER_TRUSTS,
  type InboxIndexEntry,
  type InboxPolicyDecision,
  type InboxPolicyIndex,
  type InboxPolicyReason,
  type InboxRateSample,
  type InboxRoute,
  type InboxSnapshot,
  type LetterClass,
  type LetterInput,
  type LetterRecord,
  type LetterState,
  type LetterTrust,
} from "./types.js";
import {
  LetterValidationError,
  validateLetterInput,
  type LetterValidationOptions,
} from "./validate.js";

export const INBOX_EVENTS = [
  "letter.received",
  "letter.deduped",
  "letter.coalesced",
  "letter.suppressed",
  "letter.routed",
  "letter.delivered",
  "letter.read",
  "letter.acked",
  "letter.deferred",
  "letter.expired",
  "letter.redelivered",
  "letter.dead_letter",
  "letter.observed",
] as const;
export type InboxEventType = (typeof INBOX_EVENTS)[number];

interface InboxEventBase {
  readonly schema: 1;
  readonly event: InboxEventType;
  readonly at: number;
  readonly id: string;
}

export interface InboxReceivedEvent extends InboxEventBase {
  readonly event: "letter.received";
  readonly created_at: number;
  readonly letter: LetterInput;
}

export interface InboxObservedEvent extends InboxEventBase {
  readonly event: "letter.observed";
  readonly created_at: number;
  readonly letter: LetterInput;
}

export interface InboxDedupedEvent extends InboxEventBase {
  readonly event: "letter.deduped";
  readonly source: string;
  readonly dedupe_key: string;
  readonly existing_id: string;
  readonly class: LetterClass;
  readonly trust?: LetterTrust;
}

export interface InboxCoalescedEvent extends InboxEventBase {
  readonly event: "letter.coalesced";
  readonly source: string;
  readonly coalesce_key: string;
  readonly target_id: string;
  readonly class: LetterClass;
  readonly trust?: LetterTrust;
}

export interface InboxSuppressedEvent extends InboxEventBase {
  readonly event: "letter.suppressed";
  readonly source: string;
  readonly reason: InboxPolicyReason;
  readonly class: LetterClass;
  readonly trust?: LetterTrust;
}

export interface InboxRoutedEvent extends InboxEventBase {
  readonly event: "letter.routed";
  readonly route: InboxRoute;
  readonly class: LetterClass;
}

export interface InboxDeliveredEvent extends InboxEventBase {
  readonly event: "letter.delivered";
  readonly delivered_at: number;
  readonly attempts: number;
  readonly batch_id?: string;
}

export interface InboxReadEvent extends InboxEventBase {
  readonly event: "letter.read";
  readonly read_at: number;
}

export interface InboxAckedEvent extends InboxEventBase {
  readonly event: "letter.acked";
  readonly acked_at: number;
  readonly ack_outcome?: string;
  readonly evidence_ref?: string;
  readonly note?: string;
}

export interface InboxDeferredEvent extends InboxEventBase {
  readonly event: "letter.deferred";
  readonly deferred_until: number;
}

export interface InboxExpiredEvent extends InboxEventBase {
  readonly event: "letter.expired";
}

export interface InboxRedeliveredEvent extends InboxEventBase {
  readonly event: "letter.redelivered";
  readonly attempts: number;
}

export interface InboxDeadLetterEvent extends InboxEventBase {
  readonly event: "letter.dead_letter";
  readonly reason?: string;
}

export type InboxEvent =
  | InboxReceivedEvent
  | InboxObservedEvent
  | InboxDedupedEvent
  | InboxCoalescedEvent
  | InboxSuppressedEvent
  | InboxRoutedEvent
  | InboxDeliveredEvent
  | InboxReadEvent
  | InboxAckedEvent
  | InboxDeferredEvent
  | InboxExpiredEvent
  | InboxRedeliveredEvent
  | InboxDeadLetterEvent;

export class InboxJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxJournalError";
  }
}

export interface InboxTornTail {
  readonly line_number: number;
  readonly message: string;
}

export interface InboxJournalStoreOptions {
  /** 路径注入中枢；与 stateRoot 二选一，layout 优先。 */
  readonly layout?: StateLayout;
  /** 便捷入口：等价于 new StateLayout({ root: stateRoot })。 */
  readonly stateRoot?: string;
  /** 会话 id（同时是文件名）；必须匹配 StateLayout 安全段规则。 */
  readonly sessionId: string;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  /** 尾行撕裂被 Journal 修复前上报（可观测性；不得用于阻断恢复）。 */
  readonly onTornTail?: (info: InboxTornTail) => void;
  /** 入账校验上限（T3 从 inbox.limits 传入）；replay 不套当前上限，避免配置收紧后旧账打不开。 */
  readonly validation?: LetterValidationOptions;
}

export interface InboxListFilter {
  readonly state?: LetterState;
  readonly class?: LetterClass;
  readonly source?: string;
}

export interface InboxAppendOptions {
  readonly now?: number;
  /** policy 判定结果；缺省 = 直接按 received 入账（不投递）。 */
  readonly decision?: InboxPolicyDecision;
}

export type InboxAppendResult =
  | { readonly outcome: "received"; readonly record: LetterRecord }
  | { readonly outcome: "observed"; readonly record: LetterRecord }
  | { readonly outcome: "duplicate"; readonly id: string; readonly existing_id: string }
  | { readonly outcome: "coalesced"; readonly id: string; readonly target_id: string }
  | { readonly outcome: "suppressed"; readonly id: string; readonly reason: InboxPolicyReason };

export interface InboxRateWindow {
  readonly count: number;
  readonly last_at: number | null;
}

/** 未终结状态：仍需投递/阅读/ack 的信件计入 pending。 */
const UNRESOLVED_STATES: ReadonlySet<LetterState> = new Set([
  "pending",
  "routed",
  "delivered",
  "read",
  "deferred",
]);

interface MutableLetter extends LetterInput {
  id: string;
  created_at: number;
  state: LetterState;
  attempts: number;
  delivered_at?: number;
  read_at?: number;
  acked_at?: number;
  ack_outcome?: string;
  evidence_ref?: string;
  ack_note?: string;
  deferred_until?: number;
  defer_count: number;
  batch_id?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isLetterClass(v: unknown): v is LetterClass {
  return typeof v === "string" && (LETTER_CLASSES as readonly string[]).includes(v);
}

function isLetterTrust(v: unknown): v is LetterTrust {
  return typeof v === "string" && (LETTER_TRUSTS as readonly string[]).includes(v);
}

function isRoute(v: unknown): v is InboxRoute {
  return (
    v === "send" || v === "deliver_wake" || v === "digest" || v === "observed" ||
    v === "suppressed"
  );
}

/** 轻量 shape 检查（torn 判定用；完整语义校验在 parseStoredLetter/applyEvent）。 */
function isLetterInputShape(v: unknown): v is LetterInput {
  if (!isRecord(v)) return false;
  return (
    typeof v["source"] === "string" &&
    typeof v["kind"] === "string" &&
    typeof v["principal"] === "string" &&
    typeof v["body"] === "string" &&
    isLetterClass(v["class"]) &&
    isLetterTrust(v["trust"])
  );
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Journal.isRow：结构合法返回 true；未知 event 名也返回 true（交给 replay 响亮拒绝），
 * 但已知 event 的载荷残缺返回 false（尾行按 torn 丢弃 / 中段按损坏抛错）。
 */
export function isInboxEventShape(row: JsonObjectRow): boolean {
  if (row["schema"] !== 1) return false;
  const event = row["event"];
  if (typeof event !== "string") return false;
  if (!isFiniteNumber(row["at"]) || !isNonEmptyString(row["id"])) return false;
  switch (event) {
    case "letter.received":
    case "letter.observed":
      return isFiniteNumber(row["created_at"]) && isLetterInputShape(row["letter"]);
    case "letter.deduped":
      return (
        isNonEmptyString(row["source"]) &&
        isNonEmptyString(row["dedupe_key"]) &&
        isNonEmptyString(row["existing_id"]) &&
        isLetterClass(row["class"])
      );
    case "letter.coalesced":
      return (
        isNonEmptyString(row["source"]) &&
        isNonEmptyString(row["coalesce_key"]) &&
        isNonEmptyString(row["target_id"]) &&
        isLetterClass(row["class"])
      );
    case "letter.suppressed":
      return (
        isNonEmptyString(row["source"]) &&
        isNonEmptyString(row["reason"]) &&
        isLetterClass(row["class"])
      );
    case "letter.routed":
      return isRoute(row["route"]) && isLetterClass(row["class"]);
    case "letter.delivered":
      return (
        isFiniteNumber(row["delivered_at"]) &&
        isFiniteNumber(row["attempts"]) &&
        (row["batch_id"] === undefined || typeof row["batch_id"] === "string")
      );
    case "letter.read":
      return isFiniteNumber(row["read_at"]);
    case "letter.acked":
      return isFiniteNumber(row["acked_at"]);
    case "letter.deferred":
      return isFiniteNumber(row["deferred_until"]);
    case "letter.expired":
      return true;
    case "letter.redelivered":
      return isFiniteNumber(row["attempts"]);
    case "letter.dead_letter":
      return row["reason"] === undefined || typeof row["reason"] === "string";
    default:
      // 未知事件类型：形状层放行，replay 抛 InboxJournalError（绝不按 torn 静默丢弃）。
      return true;
  }
}

function parseInboxEvent(row: JsonObjectRow): InboxEvent {
  const event = row["event"];
  if (typeof event !== "string") {
    throw new InboxJournalError("journal event missing event name");
  }
  if (!(INBOX_EVENTS as readonly string[]).includes(event)) {
    throw new InboxJournalError(`journal unknown event type: ${JSON.stringify(event)}`);
  }
  return row as unknown as InboxEvent;
}

const REPLAY_VALIDATION: LetterValidationOptions = {
  maxBodyBytes: Number.MAX_SAFE_INTEGER,
  maxTitleChars: Number.MAX_SAFE_INTEGER,
  maxRefBytes: Number.MAX_SAFE_INTEGER,
  maxKeyChars: Number.MAX_SAFE_INTEGER,
  maxPrincipalChars: Number.MAX_SAFE_INTEGER,
  maxKindChars: Number.MAX_SAFE_INTEGER,
  maxCausationDepth: Number.MAX_SAFE_INTEGER,
};

function parseStoredLetter(raw: unknown): LetterInput {
  try {
    return validateLetterInput(raw, REPLAY_VALIDATION);
  } catch (error: unknown) {
    if (error instanceof LetterValidationError) {
      throw new InboxJournalError(`journal letter payload invalid: ${error.message}`);
    }
    throw error;
  }
}

/** 扫尾行判断是否 torn（Journal 构造后会截断修复，故必须在构造前读）。 */
function detectTornTail(path: string): InboxTornTail | undefined {
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, "utf8").split("\n");
  let lastNonEmpty = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if ((lines[i] ?? "").trim().length > 0) {
      lastNonEmpty = i;
      break;
    }
  }
  if (lastNonEmpty < 0) return undefined;
  const line = lines[lastNonEmpty] ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { line_number: lastNonEmpty + 1, message: "尾行 JSON 不完整（torn tail）" };
  }
  if (!isJsonObjectRow(parsed) || !isInboxEventShape(parsed)) {
    return { line_number: lastNonEmpty + 1, message: "尾行事件形状不完整（torn tail）" };
  }
  return undefined;
}

function compareRecords(left: LetterRecord, right: LetterRecord): number {
  if (left.created_at !== right.created_at) return left.created_at - right.created_at;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/**
 * 单会话收件箱账本。单写者语义与 Journal 一致（调用方保证同一文件串行写）。
 */
export class InboxJournalStore {
  readonly filePath: string;
  private readonly _journal: Journal;
  private readonly _now: () => number;
  private readonly _idFactory: () => string;
  private readonly _validation: LetterValidationOptions;
  private readonly _letters = new Map<string, MutableLetter>();
  private readonly _dedupe = new Map<string, InboxIndexEntry>();
  private readonly _coalesce = new Map<string, InboxIndexEntry>();
  private readonly _rate = new Map<string, InboxRateSample[]>();
  private readonly _globalRate: InboxRateSample[] = [];
  private readonly _stateIndex = new Map<LetterState, Set<string>>();

  constructor(options: InboxJournalStoreOptions) {
    const layout = options.layout ?? new StateLayout(
      options.stateRoot === undefined ? {} : { root: options.stateRoot },
    );
    const { sessionId } = options;
    this._now = options.now ?? (() => Date.now());
    this._idFactory = options.idFactory ?? (() => randomUUID());
    this._validation = options.validation ?? {};
    const fileName = `${sessionId}.jsonl`;
    this.filePath = layout.filePath("inbox", fileName);
    const torn = detectTornTail(this.filePath);
    this._journal = layout.openJournal("inbox", fileName, { isRow: isInboxEventShape });
    if (torn !== undefined) options.onTornTail?.(torn);
    this.#replay(this._journal.read());
  }

  get sessionFile(): string {
    return this.filePath;
  }

  /** 有效事件行数（增量读/审计锚点）。 */
  get size(): number {
    return this._journal.size;
  }

  get(id: string): LetterRecord | undefined {
    return this._letters.get(id);
  }

  list(filter: InboxListFilter = {}): LetterRecord[] {
    const out: LetterRecord[] = [];
    for (const record of this._letters.values()) {
      if (filter.state !== undefined && record.state !== filter.state) continue;
      if (filter.class !== undefined && record.class !== filter.class) continue;
      if (filter.source !== undefined && record.source !== filter.source) continue;
      out.push(record);
    }
    return out.sort(compareRecords);
  }

  snapshot(
    options: number | { readonly now?: number; readonly knownSources?: readonly string[] } = {},
  ): InboxSnapshot {
    const opts = typeof options === "number" ? { now: options } : options;
    const now = opts.now ?? this._now();
    const known = opts.knownSources === undefined ? undefined : new Set(opts.knownSources);
    const byClass: Record<LetterClass, number> = { digest: 0, notify: 0, interrupt: 0 };
    const bySource: Record<string, number> = {};
    let pending = 0;
    let oldestCreatedAt: number | null = null;
    let digestDueAt: number | null = null;
    let unknown = 0;

    for (const record of this.#unresolvedRecords()) {
      pending += 1;
      byClass[record.class] += 1;
      bySource[record.source] = (bySource[record.source] ?? 0) + 1;
      if (oldestCreatedAt === null || record.created_at < oldestCreatedAt) {
        oldestCreatedAt = record.created_at;
      }
      if (record.class === "digest") {
        const due = record.deferred_until ?? record.not_before ?? record.created_at;
        if (digestDueAt === null || due < digestDueAt) digestDueAt = due;
      }
      if (known !== undefined && !known.has(record.source)) unknown += 1;
    }

    let deadLetter = 0;
    for (const id of this._stateIndex.get("dead_letter") ?? []) {
      if (this._letters.has(id)) deadLetter += 1;
    }

    return {
      as_of: now,
      pending,
      by_class: byClass,
      by_source: bySource,
      oldest_age_ms: oldestCreatedAt === null ? 0 : Math.max(0, now - oldestCreatedAt),
      dead_letter: deadLetter,
      unknown,
      digest_due_at: digestDueAt,
    };
  }

  /** policy 只读索引（dedupe/coalesce/rate/pending）；每次调用返回独立副本。 */
  policyIndex(): InboxPolicyIndex {
    const rate = new Map<string, readonly InboxRateSample[]>();
    for (const [source, samples] of this._rate) {
      rate.set(source, samples.map((s) => ({ ...s })));
    }
    return {
      dedupe: new Map(this._dedupe),
      coalesce: new Map(this._coalesce),
      rate,
      globalRate: this._globalRate.map((s) => ({ ...s })),
      pendingCount: this.#unresolvedRecords().length,
    };
  }

  rateWindow(source: string, now: number, windowMs = 60_000): InboxRateWindow {
    const samples = this._rate.get(source) ?? [];
    let count = 0;
    let lastAt: number | null = null;
    for (const sample of samples) {
      if (sample.at > now) continue;
      if (sample.at >= now - windowMs) count += 1;
      if (lastAt === null || sample.at > lastAt) lastAt = sample.at;
    }
    return { count, last_at: lastAt };
  }

  /**
   * 入账一封新信。缺省写 letter.received（state=pending）；
   * 若带 policy decision：duplicate/coalesced/suppressed 分别写对应事件且不建记录；
   * route=observed（shadow）写 letter.observed（state=observed）。
   */
  append(raw: unknown, options: InboxAppendOptions | number = {}): InboxAppendResult {
    const opts = typeof options === "number" ? { now: options } : options;
    const input = validateLetterInput(raw, this._validation);
    const now = opts.now ?? this._now();
    const id = this._idFactory();
    const decision = opts.decision;

    if (decision !== undefined) {
      switch (decision.outcome) {
        case "duplicate": {
          const existingId = decision.dedupe?.existing_id;
          const dedupeKey = input.dedupe_key ?? decision.dedupe?.key;
          if (existingId === undefined || dedupeKey === undefined) {
            throw new InboxJournalError("duplicate decision missing dedupe key/existing_id");
          }
          this.#appendEvent({
            schema: 1,
            event: "letter.deduped",
            at: now,
            id,
            source: input.source,
            dedupe_key: dedupeKey,
            existing_id: existingId,
            class: decision.class,
            trust: decision.trust,
          });
          return { outcome: "duplicate", id, existing_id: existingId };
        }
        case "coalesced": {
          const targetId = decision.coalesce?.target_id;
          const coalesceKey = input.coalesce_key ?? decision.coalesce?.key;
          if (targetId === undefined || coalesceKey === undefined) {
            throw new InboxJournalError("coalesced decision missing coalesce key/target_id");
          }
          this.#appendEvent({
            schema: 1,
            event: "letter.coalesced",
            at: now,
            id,
            source: input.source,
            coalesce_key: coalesceKey,
            target_id: targetId,
            class: decision.class,
            trust: decision.trust,
          });
          return { outcome: "coalesced", id, target_id: targetId };
        }
        case "suppressed": {
          this.#appendEvent({
            schema: 1,
            event: "letter.suppressed",
            at: now,
            id,
            source: input.source,
            reason: decision.reason,
            class: decision.class,
            trust: decision.trust,
          });
          return { outcome: "suppressed", id, reason: decision.reason };
        }
        case "accepted": {
          const effectiveInput: LetterInput = {
            ...input,
            class: decision.class,
            trust: decision.trust,
          };
          if (decision.route === "observed") {
            return { outcome: "observed", record: this.#appendObserved(effectiveInput, now, id) };
          }
          return this.#recordReceived(effectiveInput, now, id);
        }
        default: {
          const _exhaustive: never = decision.outcome;
          return _exhaustive;
        }
      }
    }

    return this.#recordReceived(input, now, id);
  }

  /** T3/T4 生命周期事件入口（delivered/read/acked/deferred/expired/redelivered/dead_letter）。 */
  appendEvent(event: InboxEvent): void {
    if (!isInboxEventShape(event as unknown as JsonObjectRow)) {
      throw new InboxJournalError("invalid inbox event shape");
    }
    if (event.event === "letter.received" || event.event === "letter.observed") {
      throw new InboxJournalError("use append/recordObserved for letter payload events");
    }
    if (
      event.event !== "letter.deduped" && event.event !== "letter.coalesced" &&
      event.event !== "letter.suppressed" && !this._letters.has(event.id)
    ) {
      throw new InboxJournalError(`lifecycle event references unknown letter id: ${event.id}`);
    }
    this.#appendEvent(event);
  }

  /** shadow 观测：只落账、不投递；snapshot 不计入 pending。 */
  recordObserved(raw: unknown, options: { readonly now?: number } = {}): LetterRecord {
    const input = validateLetterInput(raw, this._validation);
    const now = options.now ?? this._now();
    return this.#appendObserved(input, now, this._idFactory());
  }

  #recordReceived(input: LetterInput, now: number, id: string): InboxAppendResult {
    const event: InboxReceivedEvent = {
      schema: 1,
      event: "letter.received",
      at: now,
      id,
      created_at: now,
      letter: input,
    };
    this.#appendEvent(event);
    const record = this._letters.get(id);
    if (record === undefined) throw new InboxJournalError("received event did not materialize");
    return { outcome: "received", record };
  }

  #appendObserved(input: LetterInput, now: number, id: string): LetterRecord {
    const event: InboxObservedEvent = {
      schema: 1,
      event: "letter.observed",
      at: now,
      id,
      created_at: now,
      letter: input,
    };
    this.#appendEvent(event);
    const record = this._letters.get(id);
    if (record === undefined) throw new InboxJournalError("observed event did not materialize");
    return record;
  }

  #appendEvent(event: InboxEvent): void {
    // 先落盘、成功后才进内存（Journal 语义）。
    this._journal.append(event as unknown as JsonObjectRow);
    this.#applyEvent(event);
  }

  #replay(rows: readonly JsonObjectRow[]): void {
    for (const row of rows) {
      this.#applyEvent(parseInboxEvent(row));
    }
  }

  #applyEvent(event: InboxEvent): void {
    switch (event.event) {
      case "letter.received":
      case "letter.observed": {
        const letter = parseStoredLetter(event.letter);
        if (this._letters.has(event.id)) {
          throw new InboxJournalError(`duplicate letter id in journal: ${event.id}`);
        }
        const record: MutableLetter = {
          ...letter,
          id: event.id,
          created_at: event.created_at,
          state: event.event === "letter.observed" ? "observed" : "pending",
          attempts: 0,
          defer_count: 0,
        };
        this._letters.set(record.id, record);
        this.#addToStateIndex(record.state, record.id);
        if (record.dedupe_key !== undefined) {
          this._dedupe.set(record.dedupe_key, { id: record.id, at: record.created_at });
        }
        if (record.coalesce_key !== undefined) {
          this._coalesce.set(record.coalesce_key, { id: record.id, at: record.created_at });
        }
        this.#recordRate(record.source, record.class, event.at);
        return;
      }
      case "letter.deduped": {
        this.#recordRate(event.source, event.class, event.at);
        return;
      }
      case "letter.coalesced": {
        this._coalesce.set(event.coalesce_key, { id: event.target_id, at: event.at });
        this.#recordRate(event.source, event.class, event.at);
        return;
      }
      case "letter.suppressed": {
        this.#recordRate(event.source, event.class, event.at);
        return;
      }
      case "letter.routed": {
        const record = this.#requireLetter(event.id, event.event);
        this.#transition(record, "routed");
        return;
      }
      case "letter.delivered": {
        const record = this.#requireLetter(event.id, event.event);
        record.delivered_at = event.delivered_at;
        record.attempts = event.attempts;
        if (event.batch_id !== undefined) record.batch_id = event.batch_id;
        this.#transition(record, "delivered");
        return;
      }
      case "letter.read": {
        const record = this.#requireLetter(event.id, event.event);
        record.read_at = event.read_at;
        this.#transition(record, "read");
        return;
      }
      case "letter.acked": {
        const record = this.#requireLetter(event.id, event.event);
        record.acked_at = event.acked_at;
        if (event.ack_outcome !== undefined) record.ack_outcome = event.ack_outcome;
        if (event.evidence_ref !== undefined) record.evidence_ref = event.evidence_ref;
        if (event.note !== undefined) record.ack_note = event.note;
        this.#transition(record, "acked");
        return;
      }
      case "letter.deferred": {
        const record = this.#requireLetter(event.id, event.event);
        record.deferred_until = event.deferred_until;
        record.defer_count += 1;
        this.#transition(record, "deferred");
        return;
      }
      case "letter.expired": {
        const record = this.#requireLetter(event.id, event.event);
        this.#transition(record, "expired");
        return;
      }
      case "letter.redelivered": {
        const record = this.#requireLetter(event.id, event.event);
        record.attempts = event.attempts;
        this.#transition(record, "pending");
        return;
      }
      case "letter.dead_letter": {
        const record = this.#requireLetter(event.id, event.event);
        this.#transition(record, "dead_letter");
        return;
      }
      default: {
        const _exhaustive: never = event;
        throw new InboxJournalError(`unhandled event: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  #requireLetter(id: string, event: string): MutableLetter {
    const record = this._letters.get(id);
    if (record === undefined) {
      throw new InboxJournalError(`journal ${event} references unknown letter id: ${id}`);
    }
    return record;
  }

  #transition(record: MutableLetter, next: LetterState): void {
    if (record.state === next) return;
    this._stateIndex.get(record.state)?.delete(record.id);
    record.state = next;
    this.#addToStateIndex(next, record.id);
  }

  #addToStateIndex(state: LetterState, id: string): void {
    let set = this._stateIndex.get(state);
    if (set === undefined) {
      set = new Set();
      this._stateIndex.set(state, set);
    }
    set.add(id);
  }

  #recordRate(source: string, letterClass: LetterClass, at: number): void {
    let samples = this._rate.get(source);
    if (samples === undefined) {
      samples = [];
      this._rate.set(source, samples);
    }
    const sample: InboxRateSample = { at, class: letterClass };
    samples.push(sample);
    this._globalRate.push(sample);
  }

  #unresolvedRecords(): LetterRecord[] {
    const out: LetterRecord[] = [];
    for (const state of UNRESOLVED_STATES) {
      for (const id of this._stateIndex.get(state) ?? []) {
        const record = this._letters.get(id);
        if (record !== undefined) out.push(record);
      }
    }
    return out;
  }
}
