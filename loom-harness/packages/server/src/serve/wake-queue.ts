/**
 * T05a/T05b：持久化多条目唤醒队列核心与每会话定时投递。
 *
 * 状态面 `{stateRoot}/session/wake-queue/{sessionID}.json`（schema 2，原子写）：
 *   { schema: 2, session_id, entries: [], delivered: [], legacy_migrated_at? }
 *
 * T05a 面：排队、来源对账、归档读取与实例锁，全部写操作经进程内 promise 串行链。
 * T05b 面：每会话仅一个 setTimeout，始终指向最早待办；到点认领 -> render ->
 * deliver，失败只重试一次（now + 30s），随后归档 failed 并回调死信。
 * render/deliver 未同时配置时保持 T05a 纯队列行为（不排定时器）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { isWakeAction, type WakeAction, type WakeSource } from "../plan/actions.js";
import { stringifyStableJson, writeJsonAtomic } from "../plan/atomic-write.js";
import type { WakeEntry } from "../plan/wake-render.js";

export const WAKE_QUEUE_SCHEMA = 2;
export const WAKE_QUEUE_SOURCES = ["plan", "flow", "special"] as const;
export type WakeQueueSource = (typeof WAKE_QUEUE_SOURCES)[number];

/** 计划条目保留 48h，flow/special 保留 30d（自 scheduled at 起算）。 */
export const PLAN_RETENTION_MS = 48 * 60 * 60 * 1000;
export const OTHER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const LEGACY_WAKE_ID = "legacy-auto-wake";

/** T05b：投递失败后的唯一一次重试延迟；不做指数退避。 */
export const WAKE_QUEUE_RETRY_MS = 30_000;
/** T05b：首次失败 + 一次重试，共两次投递尝试。 */
export const WAKE_QUEUE_MAX_ATTEMPTS = 2;
/** T05b：已归档记录上限（保留最近 500 条）。 */
export const WAKE_QUEUE_DELIVERED_CAP = 500;
/** setTimeout 的兼容上限；更远的唤醒按块续排。 */
const DEFAULT_MAX_TIMER_MS = 2_147_000_000;

export type WakeQueueDeliveryOutcome = "delivered" | "stale" | "failed";
export type WakeQueueStaleReason = "render" | "session";

export interface WakeQueueEntry {
  readonly id: string;
  readonly source: WakeQueueSource;
  readonly action?: WakeAction;
  readonly at: number;
  readonly payload: unknown;
  readonly instruction?: string;
  readonly created_at: number;
  readonly attempts: number;
  readonly expires_at?: number;
}

/** 与需求文档 snapshot() 的 Entry 命名对齐。 */
export type Entry = WakeQueueEntry;

export interface WakeQueueDelivered {
  readonly id: string;
  readonly at: number;
  readonly delivered_at: number;
  readonly outcome?: WakeQueueDeliveryOutcome;
  readonly attempts?: number;
  readonly error?: string;
}

/** 与需求文档 snapshot() 的 Delivered 命名对齐。 */
export type Delivered = WakeQueueDelivered;

/** 入队输入：created_at/attempts 可缺省，由队列补齐。 */
export interface WakeQueueEntryInput {
  readonly id: string;
  readonly source?: WakeQueueSource;
  readonly action?: WakeAction;
  readonly at: number;
  readonly payload?: unknown;
  readonly instruction?: string;
  readonly created_at?: number;
  readonly attempts?: number;
  readonly expires_at?: number;
}

export type WakeQueueEnqueueResult = "inserted" | "updated" | "duplicate" | "suppressed";

export interface WakeQueueReconcileResult {
  readonly added: number;
  readonly updated: number;
  readonly cancelled: number;
}

export interface WakeQueueRestoreResult {
  readonly restored: number;
  readonly migratedLegacy: boolean;
  readonly dropped: number;
}

export interface WakeQueueSnapshot {
  readonly entries: readonly Entry[];
  readonly delivered: readonly Delivered[];
}

export interface WakeQueueInstanceOwner {
  readonly pid: number;
  readonly started_at: number;
}

export interface WakeQueuePaths {
  readonly dir: string;
  readonly sidecar: string;
  readonly instance: string;
  readonly legacy: string;
}

export type WakeQueueObservation =
  | { readonly kind: "restore"; readonly restored: number; readonly migratedLegacy: boolean; readonly dropped: number }
  | { readonly kind: "enqueue"; readonly id: string; readonly result: WakeQueueEnqueueResult }
  | { readonly kind: "cancel"; readonly id: string; readonly cancelled: boolean }
  | { readonly kind: "reconcile"; readonly source: WakeQueueSource; readonly result: WakeQueueReconcileResult }
  | { readonly kind: "corrupt"; readonly path: string; readonly message: string }
  | { readonly kind: "legacy-renamed"; readonly path: string; readonly renamedTo: string }
  | { readonly kind: "watchdog"; readonly reloaded: boolean; readonly pending: number }
  | { readonly kind: "wake.armed"; readonly at: number; readonly delayMs: number; readonly pending: number }
  | { readonly kind: "wake.delivered"; readonly id: string; readonly at: number; readonly attempts: number }
  | { readonly kind: "wake.stale"; readonly id: string; readonly at: number; readonly reason: WakeQueueStaleReason }
  | {
      readonly kind: "wake.failed";
      readonly id: string;
      readonly at: number;
      readonly attempts: number;
      readonly message: string;
    }
  | { readonly kind: "error"; readonly operation: string; readonly message: string };

export interface WakeQueueOptions {
  readonly stateRoot: string;
  readonly sessionID: string;
  readonly now?: () => number;
  readonly observe?: (event: WakeQueueObservation) => void;
  /** 来源感知渲染；返回 null 表示条目已失效（归档 stale，不投递）。 */
  readonly render?: (entry: WakeQueueEntry) => string | null;
  /** 把渲染行交给会话；抛错触发唯一一次重试。 */
  readonly deliver?: (sessionID: string, line: string, entry: WakeQueueEntry) => Promise<void> | void;
  /** 会话是否仍存在；false 时归档 stale 且不投递。 */
  readonly hasSession?: (sessionID: string) => boolean;
  readonly maxTimerMs?: number;
  readonly onDeadLetter?: (entry: WakeQueueEntry, error: unknown) => void;
}

export type WakeQueuePhase = "options" | "validate" | "lock" | "read" | "write" | "legacy";

export class WakeQueueError extends Error {
  readonly phase: WakeQueuePhase;
  constructor(message: string, phase: WakeQueuePhase, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WakeQueueError";
    this.phase = phase;
  }
}

export class WakeQueueValidationError extends WakeQueueError {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`[wake-queue:validation] ${field}: ${message}`, "validate");
    this.name = "WakeQueueValidationError";
    this.field = field;
  }
}

export class WakeQueueLockedError extends WakeQueueError {
  readonly lockPath: string;
  readonly owner: WakeQueueInstanceOwner | null;
  constructor(lockPath: string, owner: WakeQueueInstanceOwner | null) {
    super(
      owner === null
        ? `[wake-queue:locked] ${lockPath}: 实例锁不可解析`
        : `[wake-queue:locked] ${lockPath}: pid ${String(owner.pid)} 仍在运行`,
      "lock",
    );
    this.name = "WakeQueueLockedError";
    this.lockPath = lockPath;
    this.owner = owner;
  }
}

interface QueueState {
  readonly entries: readonly WakeQueueEntry[];
  readonly delivered: readonly WakeQueueDelivered[];
  readonly legacyMigratedAt: number | undefined;
}

interface NormalizedEntryInput {
  readonly id: string;
  readonly source: WakeQueueSource;
  readonly action: WakeAction | undefined;
  readonly at: number;
  readonly payload: unknown;
  readonly instruction: string | undefined;
  readonly created_at: number | undefined;
  readonly attempts: number | undefined;
  readonly expires_at: number | undefined;
}

interface UpsertOutcome {
  readonly entries: readonly WakeQueueEntry[];
  readonly result: WakeQueueEnqueueResult;
}

const SID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertNever(value: never): never {
  throw new Error(`unhandled wake queue variant: ${String(value)}`);
}

type TimerHandle = ReturnType<typeof setTimeout>;

function unrefTimer(handle: TimerHandle): void {
  // vitest 假定时器的返回值可能不是 NodeJS.Timeout；unref 缺失时静默跳过。
  const candidate: { unref?: () => void } = handle;
  candidate.unref?.();
}

function emptyState(): QueueState {
  return { entries: [], delivered: [], legacyMigratedAt: undefined };
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WakeQueueValidationError(field, `必须是非空字符串: ${String(value)}`);
  }
  return value;
}

function requireSource(value: unknown): WakeQueueSource {
  if (value === "plan" || value === "flow" || value === "special") return value;
  throw new WakeQueueValidationError("source", `必须是 plan/flow/special: ${String(value)}`);
}

function requireFinite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WakeQueueValidationError(field, `必须是有限数: ${String(value)}`);
  }
  return value;
}

function requireAttempts(value: unknown): number {
  const attempts = requireFinite(value, "attempts");
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new WakeQueueValidationError("attempts", `必须是非负整数: ${String(value)}`);
  }
  return attempts;
}

/** payload 必须在碰盘前证明可序列化；失败即拒绝入队。 */
function payloadKey(payload: unknown): string {
  try {
    return stringifyStableJson(payload);
  } catch (error) {
    throw new WakeQueueValidationError("payload", `必须是可序列化 JSON: ${errorMessage(error)}`);
  }
}

function retentionMs(source: WakeQueueSource): number {
  switch (source) {
    case "plan":
      return PLAN_RETENTION_MS;
    case "flow":
    case "special":
      return OTHER_RETENTION_MS;
    default:
      return assertNever(source);
  }
}

function isExpired(entry: WakeQueueEntry, now: number): boolean {
  if (entry.expires_at !== undefined && now >= entry.expires_at) return true;
  return now - entry.at > retentionMs(entry.source);
}

function sortEntries(entries: readonly WakeQueueEntry[]): WakeQueueEntry[] {
  return [...entries].sort((left, right) => {
    if (left.at !== right.at) return left.at - right.at;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

function cloneJson(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (text === undefined) return null;
  return JSON.parse(text);
}

function cloneEntry(entry: WakeQueueEntry): WakeQueueEntry {
  return { ...entry, payload: cloneJson(entry.payload) };
}

function requireStoredEntry(raw: unknown): WakeQueueEntry {
  if (!isRecord(raw)) throw new WakeQueueValidationError("entry", "必须是对象");
  const id = requireId(raw["id"], "entry.id");
  const source = requireSource(raw["source"]);
  const at = requireFinite(raw["at"], "entry.at");
  const payload = raw["payload"] === undefined ? {} : raw["payload"];
  const createdRaw = raw["created_at"];
  const created_at = createdRaw === undefined ? at : requireFinite(createdRaw, "entry.created_at");
  const attemptsRaw = raw["attempts"];
  const attempts = attemptsRaw === undefined ? 0 : requireAttempts(attemptsRaw);
  const action = raw["action"];
  if (action !== undefined && !isWakeAction(action)) {
    throw new WakeQueueValidationError("entry.action", `未知动作: ${String(action)}`);
  }
  const instruction = raw["instruction"];
  if (instruction !== undefined && typeof instruction !== "string") {
    throw new WakeQueueValidationError("entry.instruction", "必须是字符串");
  }
  const expiresRaw = raw["expires_at"];
  const expires_at = expiresRaw === undefined ? undefined : requireFinite(expiresRaw, "entry.expires_at");
  return {
    id,
    source,
    ...(action === undefined ? {} : { action }),
    at,
    payload,
    ...(instruction === undefined ? {} : { instruction }),
    created_at,
    attempts,
    ...(expires_at === undefined ? {} : { expires_at }),
  };
}

function requireDelivered(raw: unknown): WakeQueueDelivered {
  if (!isRecord(raw)) throw new WakeQueueValidationError("delivered", "必须是对象");
  const id = requireId(raw["id"], "delivered.id");
  const atRaw = raw["at"];
  const at = atRaw === undefined ? 0 : requireFinite(atRaw, "delivered.at");
  const deliveredRaw = raw["delivered_at"];
  const delivered_at = deliveredRaw === undefined ? at : requireFinite(deliveredRaw, "delivered.delivered_at");
  const outcomeRaw = raw["outcome"];
  if (outcomeRaw !== undefined && outcomeRaw !== "delivered" && outcomeRaw !== "stale" && outcomeRaw !== "failed") {
    throw new WakeQueueValidationError("delivered.outcome", `未知归档结果: ${String(outcomeRaw)}`);
  }
  const attemptsRaw = raw["attempts"];
  const attempts = attemptsRaw === undefined ? undefined : requireAttempts(attemptsRaw);
  const errorRaw = raw["error"];
  if (errorRaw !== undefined && typeof errorRaw !== "string") {
    throw new WakeQueueValidationError("delivered.error", "必须是字符串");
  }
  return {
    id,
    at,
    delivered_at,
    ...(outcomeRaw === undefined ? {} : { outcome: outcomeRaw }),
    ...(attempts === undefined ? {} : { attempts }),
    ...(errorRaw === undefined ? {} : { error: errorRaw }),
  };
}

function parseSidecar(raw: unknown, sessionID: string): QueueState {
  if (!isRecord(raw)) throw new WakeQueueValidationError("sidecar", "必须是对象");
  if (raw["schema"] !== WAKE_QUEUE_SCHEMA) {
    throw new WakeQueueValidationError("sidecar.schema", `必须是 ${String(WAKE_QUEUE_SCHEMA)}`);
  }
  if (raw["session_id"] !== sessionID) {
    throw new WakeQueueValidationError("sidecar.session_id", "与当前会话不一致");
  }
  const entriesRaw = raw["entries"];
  const deliveredRaw = raw["delivered"];
  if (!Array.isArray(entriesRaw)) throw new WakeQueueValidationError("sidecar.entries", "必须是数组");
  if (!Array.isArray(deliveredRaw)) throw new WakeQueueValidationError("sidecar.delivered", "必须是数组");
  const legacyRaw = raw["legacy_migrated_at"];
  const legacyMigratedAt = legacyRaw === undefined ? undefined : requireFinite(legacyRaw, "sidecar.legacy_migrated_at");
  return {
    entries: sortEntries(entriesRaw.map(requireStoredEntry)),
    delivered: deliveredRaw.map(requireDelivered),
    legacyMigratedAt,
  };
}

function normalizeInput(
  input: unknown,
  fallbackSource: WakeQueueSource | undefined,
): NormalizedEntryInput {
  if (!isRecord(input)) throw new WakeQueueValidationError("entry", "必须是对象");
  const id = requireId(input["id"], "id");
  const source = requireSource(input["source"] ?? fallbackSource);
  const at = requireFinite(input["at"], "at");
  const payload = input["payload"] === undefined ? {} : input["payload"];
  payloadKey(payload);
  const action = input["action"];
  if (action !== undefined && !isWakeAction(action)) {
    throw new WakeQueueValidationError("action", `未知动作: ${String(action)}`);
  }
  const instruction = input["instruction"];
  if (instruction !== undefined && typeof instruction !== "string") {
    throw new WakeQueueValidationError("instruction", "必须是字符串");
  }
  const createdRaw = input["created_at"];
  const created_at = createdRaw === undefined ? undefined : requireFinite(createdRaw, "created_at");
  const attemptsRaw = input["attempts"];
  const attempts = attemptsRaw === undefined ? undefined : requireAttempts(attemptsRaw);
  const expiresRaw = input["expires_at"];
  const expires_at = expiresRaw === undefined ? undefined : requireFinite(expiresRaw, "expires_at");
  return { id, source, action, at, payload, instruction, created_at, attempts, expires_at };
}

function materialize(
  input: NormalizedEntryInput,
  existing: WakeQueueEntry | undefined,
  now: number,
): WakeQueueEntry {
  return {
    id: input.id,
    source: input.source,
    ...(input.action === undefined ? {} : { action: input.action }),
    at: input.at,
    payload: cloneJson(input.payload),
    ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
    created_at: input.created_at ?? existing?.created_at ?? now,
    attempts: input.attempts ?? 0,
    ...(input.expires_at === undefined ? {} : { expires_at: input.expires_at }),
  };
}

/** 幂等 upsert：id 已归档 -> suppressed；同 id/at/payload -> duplicate；否则更新。 */
function upsertEntry(
  entries: readonly WakeQueueEntry[],
  delivered: readonly WakeQueueDelivered[],
  input: NormalizedEntryInput,
  now: number,
): UpsertOutcome {
  if (delivered.some((record) => record.id === input.id)) {
    return { entries, result: "suppressed" };
  }
  const index = entries.findIndex((entry) => entry.id === input.id);
  if (index === -1) {
    return { entries: sortEntries([...entries, materialize(input, undefined, now)]), result: "inserted" };
  }
  const existing = entries[index];
  if (existing === undefined) {
    return { entries, result: "duplicate" };
  }
  if (existing.at === input.at && payloadKey(existing.payload) === payloadKey(input.payload)) {
    return { entries, result: "duplicate" };
  }
  const next = [...entries];
  next[index] = materialize(input, existing, now);
  return { entries: sortEntries(next), result: "updated" };
}

function readInstanceOwner(path: string): WakeQueueInstanceOwner | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { pid, started_at: startedAt } = parsed;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  return { pid, started_at: startedAt };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

function payloadTitle(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const title = payload["title"];
  return typeof title === "string" && title.trim() !== "" ? title : null;
}

/** 队列来源是合并档：plan 覆盖 master/anchor/long_term，渲染统一走 master。 */
function renderSource(source: WakeQueueSource): WakeSource {
  switch (source) {
    case "plan":
      return "master";
    case "flow":
      return "flow";
    case "special":
      return "special";
    default:
      return assertNever(source);
  }
}

/**
 * 渲染桥：把队列条目投影为 WakeEntry（title 取 payload.title，缺省回落到 id）。
 * T05b 只需调用本函数即可复用现有 wake-render 分派，不反向依赖队列存储。
 */
export function toWakeEntry(entry: WakeQueueEntry): WakeEntry {
  return {
    id: entry.id,
    title: payloadTitle(entry.payload) ?? entry.id,
    source: renderSource(entry.source),
    ...(entry.action === undefined ? {} : { action: entry.action }),
    at: entry.at,
    ...(entry.instruction === undefined ? {} : { instructions: entry.instruction }),
    payload: entry.payload,
  };
}

/**
 * 单会话持久化唤醒队列。
 *
 * 进程内串行：所有 public 读写方法都经同一条 promise 链，避免交错写。
 * 跨进程互斥：stateRoot 级 `.instance.json`（O_EXCL + pid 存活检查）。
 */
export class WakeQueue {
  readonly #sessionID: string;
  readonly #now: () => number;
  readonly #observeSink: ((event: WakeQueueObservation) => void) | undefined;
  readonly #render: ((entry: WakeQueueEntry) => string | null) | undefined;
  readonly #deliver:
    | ((sessionID: string, line: string, entry: WakeQueueEntry) => Promise<void> | void)
    | undefined;
  readonly #hasSession: ((sessionID: string) => boolean) | undefined;
  readonly #onDeadLetter: ((entry: WakeQueueEntry, error: unknown) => void) | undefined;
  readonly #maxTimerMs: number;
  readonly #paths: WakeQueuePaths;

  #entries: WakeQueueEntry[] = [];
  #delivered: WakeQueueDelivered[] = [];
  #legacyMigratedAt: number | undefined;
  #loaded = false;
  #lockHeld = false;
  #disposed = false;
  #mtimeNs: bigint | null = null;
  #timer: TimerHandle | null = null;
  #timerAt: number | null = null;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: WakeQueueOptions) {
    if (typeof options.stateRoot !== "string" || options.stateRoot.trim() === "") {
      throw new WakeQueueValidationError("stateRoot", "必须是非空路径");
    }
    if (typeof options.sessionID !== "string" || !SID_RE.test(options.sessionID)) {
      throw new WakeQueueValidationError("sessionID", `非法会话 id: ${String(options.sessionID)}`);
    }
    const stateRoot = resolve(options.stateRoot);
    this.#sessionID = options.sessionID;
    this.#now = options.now ?? Date.now;
    this.#observeSink = options.observe;
    this.#render = options.render;
    this.#deliver = options.deliver;
    this.#hasSession = options.hasSession;
    this.#onDeadLetter = options.onDeadLetter;
    const configured = options.maxTimerMs ?? DEFAULT_MAX_TIMER_MS;
    this.#maxTimerMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_TIMER_MS;
    const dir = join(stateRoot, "session", "wake-queue");
    this.#paths = {
      dir,
      sidecar: join(dir, `${this.#sessionID}.json`),
      instance: join(dir, ".instance.json"),
      legacy: join(stateRoot, "session", "wake", `${this.#sessionID}.json`),
    };
  }

  paths(): WakeQueuePaths {
    return { ...this.#paths };
  }

  /**
   * 实例锁：不存在则 O_EXCL 创建；存在且 pid 存活 -> WakeQueueLockedError；
   * pid 已死或锁不可解析 -> 接管。本实例已持锁时幂等返回。
   */
  acquireInstanceLock(): void {
    if (this.#lockHeld) return;
    mkdirSync(this.#paths.dir, { recursive: true });
    const lockPath = this.#paths.instance;
    const body = `${JSON.stringify({ pid: process.pid, started_at: this.#nowMs() })}\n`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        writeFileSync(lockPath, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
        this.#lockHeld = true;
        return;
      } catch (error) {
        if (!isErrno(error, "EEXIST")) {
          throw new WakeQueueError(`[wake-queue:lock] ${lockPath}: ${errorMessage(error)}`, "lock", error);
        }
      }
      const owner = readInstanceOwner(lockPath);
      if (owner !== null && isPidAlive(owner.pid)) throw new WakeQueueLockedError(lockPath, owner);
      try {
        unlinkSync(lockPath);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) {
          throw new WakeQueueError(`[wake-queue:lock] ${lockPath}: ${errorMessage(error)}`, "lock", error);
        }
      }
    }
    throw new WakeQueueLockedError(lockPath, readInstanceOwner(lockPath));
  }

  /**
   * 读取 sidecar、迁移旧 wake/{sid}.json、剔除过期条目。
   * 损坏 sidecar 一律当空队列处理，绝不抛错；迁移先落队列再改名旧文件。
   * 恢复完成后才武装定时器，避免构造期提前投递。
   */
  async restore(): Promise<WakeQueueRestoreResult> {
    const result = await this.#serial(async () => {
      const loaded = await this.#load(true);
      this.#arm();
      return loaded;
    });
    this.#emit({ kind: "restore", ...result });
    return result;
  }

  async enqueue(entry: WakeQueueEntryInput): Promise<WakeQueueEnqueueResult> {
    const result = await this.#serial(async () => {
      await this.#ensureLoaded();
      const now = this.#nowMs();
      const normalized = normalizeInput(entry, undefined);
      const outcome = upsertEntry(this.#entries, this.#delivered, normalized, now);
      if (outcome.result === "inserted" || outcome.result === "updated") {
        this.#writeState(outcome.entries, this.#delivered, this.#legacyMigratedAt);
        this.#entries = [...outcome.entries];
      }
      this.#arm();
      return outcome.result;
    });
    this.#emit({ kind: "enqueue", id: entry.id, result });
    return result;
  }

  async cancel(id: string): Promise<boolean> {
    const cancelled = await this.#serial(async () => {
      await this.#ensureLoaded();
      const index = this.#entries.findIndex((entry) => entry.id === id);
      if (index === -1) {
        this.#arm();
        return false;
      }
      const next = [...this.#entries];
      next.splice(index, 1);
      this.#writeState(next, this.#delivered, this.#legacyMigratedAt);
      this.#entries = next;
      this.#arm();
      return true;
    });
    this.#emit({ kind: "cancel", id, cancelled });
    return cancelled;
  }

  /**
   * 来源级对账：按入参 upsert 该来源，并取消该来源中不在新集合里的未投递条目。
   * 其他来源与 delivered 归档一律不动；入参来源与参数不一致时拒绝。
   */
  async reconcileSource(
    source: WakeQueueSource,
    entries: readonly WakeQueueEntryInput[],
  ): Promise<WakeQueueReconcileResult> {
    const scopedSource = requireSource(source);
    if (!Array.isArray(entries)) {
      throw new WakeQueueValidationError("entries", "必须是数组");
    }
    const result = await this.#serial(async () => {
      await this.#ensureLoaded();
      const now = this.#nowMs();
      let current = [...this.#entries];
      const keep = new Set<string>();
      let added = 0;
      let updated = 0;
      for (const raw of entries) {
        if (!isRecord(raw)) throw new WakeQueueValidationError("entry", "必须是对象");
        const declared = raw["source"];
        if (declared !== undefined && declared !== scopedSource) {
          throw new WakeQueueValidationError(
            "source",
            `reconcileSource(${scopedSource}) 收到 ${String(declared)} 条目`,
          );
        }
        const normalized = normalizeInput(raw, scopedSource);
        keep.add(normalized.id);
        const outcome = upsertEntry(current, this.#delivered, normalized, now);
        current = [...outcome.entries];
        if (outcome.result === "inserted") added += 1;
        if (outcome.result === "updated") updated += 1;
      }
      const next = current.filter((entry) => entry.source !== scopedSource || keep.has(entry.id));
      const cancelled = current.length - next.length;
      if (added > 0 || updated > 0 || cancelled > 0) {
        this.#writeState(next, this.#delivered, this.#legacyMigratedAt);
        this.#entries = next;
      }
      this.#arm();
      return { added, updated, cancelled };
    });
    this.#emit({ kind: "reconcile", source: scopedSource, result });
    return result;
  }

  async snapshot(): Promise<WakeQueueSnapshot> {
    return this.#serial(async () => {
      await this.#ensureLoaded();
      return {
        entries: this.#entries.map(cloneEntry),
        delivered: this.#delivered.map((record) => ({ ...record })),
      };
    });
  }

  async pendingCount(): Promise<number> {
    return this.#serial(async () => {
      await this.#ensureLoaded();
      return this.#entries.length;
    });
  }

  /**
   * 看门狗：sidecar mtime 变化时重读，并在待办非空且无活动定时器时重新武装。
   * T05b 返回 true 仅表示本次调用实际（重新）排定了定时器；未接 render/deliver
   * 的纯队列保持 T05a 语义：重读后仍有待办时返回 true，供上层自行武装。
   */
  async watchdogTick(): Promise<boolean> {
    const outcome = await this.#serial(async () => {
      await this.#ensureLoaded();
      const signature = this.#signature();
      let reloaded = false;
      let pending = this.#entries.length;
      if (signature !== this.#mtimeNs) {
        const read = this.#readSidecar();
        if (read.corrupt !== null) {
          this.#emit({ kind: "corrupt", path: this.#paths.sidecar, message: read.corrupt });
        }
        this.#entries = [...read.state.entries];
        this.#delivered = [...read.state.delivered];
        this.#legacyMigratedAt = read.state.legacyMigratedAt;
        this.#mtimeNs = signature;
        reloaded = true;
        pending = read.state.entries.length;
      }
      if (!this.#operative()) {
        return { reloaded, pending, rearm: reloaded && pending > 0 };
      }
      if (pending === 0) {
        this.#clearTimer();
        return { reloaded, pending, rearm: false };
      }
      const rearm = reloaded || this.#timer === null ? this.#arm() : false;
      return { reloaded, pending, rearm };
    });
    this.#emit({ kind: "watchdog", reloaded: outcome.reloaded, pending: outcome.pending });
    return outcome.rearm;
  }

  /** 停止所有定时器并拒绝后续投递；已认领条目回队列等待下次 restore。 */
  dispose(): void {
    this.#disposed = true;
    this.#clearTimer();
  }

  #serial<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.#tail.then(fn, fn);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    await this.#load(false);
  }

  #operative(): boolean {
    return this.#render !== undefined && this.#deliver !== undefined;
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#timerAt = null;
  }

  /** 单定时器对齐最早待办；返回 true 仅表示本次新排定了定时器。 */
  #arm(): boolean {
    if (this.#disposed) {
      this.#clearTimer();
      return false;
    }
    const earliest = this.#entries[0];
    if (earliest === undefined || !this.#operative()) {
      this.#clearTimer();
      return false;
    }
    if (this.#timer !== null && this.#timerAt === earliest.at) return false;
    this.#clearTimer();
    const delay = Math.max(0, Math.min(earliest.at - this.#nowMs(), this.#maxTimerMs));
    const handle = setTimeout(() => {
      this.#onTimer(handle);
    }, delay);
    unrefTimer(handle);
    this.#timer = handle;
    this.#timerAt = earliest.at;
    this.#emit({ kind: "wake.armed", at: earliest.at, delayMs: delay, pending: this.#entries.length });
    return true;
  }

  #onTimer(handle: TimerHandle): void {
    if (this.#timer !== handle) return;
    this.#timer = null;
    this.#timerAt = null;
    if (this.#disposed) return;
    const earliest = this.#entries[0];
    if (earliest === undefined) return;
    let now: number;
    try {
      now = this.#nowMs();
    } catch (error) {
      this.#emit({ kind: "error", operation: "wake-timer", message: errorMessage(error) });
      return;
    }
    if (now < earliest.at) {
      this.#arm();
      return;
    }
    void this.#fire();
  }

  async #fire(): Promise<void> {
    try {
      const claimed = await this.#serial(async () => {
        await this.#ensureLoaded();
        if (this.#disposed) return null;
        const earliest = this.#entries[0];
        if (earliest === undefined) return null;
        const next = this.#entries.slice(1);
        this.#writeState(next, this.#delivered, this.#legacyMigratedAt);
        this.#entries = next;
        return cloneEntry(earliest);
      });
      if (claimed === null) {
        this.#arm();
        return;
      }
      await this.#attempt(claimed);
    } catch (error) {
      this.#emit({ kind: "error", operation: "wake-fire", message: errorMessage(error) });
      this.#arm();
    }
  }

  async #attempt(entry: WakeQueueEntry): Promise<void> {
    if (this.#disposed) {
      await this.#requeue(entry);
      return;
    }
    if (this.#hasSession !== undefined) {
      let present = true;
      try {
        present = this.#hasSession(this.#sessionID);
      } catch (error) {
        // 会话探测自炸按“未知”处理并继续投递，避免静默丢唤醒。
        this.#emit({ kind: "error", operation: "wake-has-session", message: errorMessage(error) });
      }
      if (!present) {
        await this.#archive(entry, "stale");
        this.#emit({ kind: "wake.stale", id: entry.id, at: entry.at, reason: "session" });
        this.#arm();
        return;
      }
    }
    const render = this.#render;
    const deliver = this.#deliver;
    if (render === undefined || deliver === undefined) {
      await this.#requeue(entry);
      this.#arm();
      return;
    }
    let line: string | null;
    try {
      line = render(entry);
    } catch (error) {
      await this.#handleFailure(entry, error);
      return;
    }
    if (line === null) {
      await this.#archive(entry, "stale");
      this.#emit({ kind: "wake.stale", id: entry.id, at: entry.at, reason: "render" });
      this.#arm();
      return;
    }
    if (this.#disposed) {
      await this.#requeue(entry);
      return;
    }
    try {
      await deliver(this.#sessionID, line, entry);
    } catch (error) {
      await this.#handleFailure(entry, error);
      return;
    }
    await this.#archive(entry, "delivered");
    this.#emit({ kind: "wake.delivered", id: entry.id, at: entry.at, attempts: entry.attempts });
    this.#arm();
  }

  async #handleFailure(entry: WakeQueueEntry, error: unknown): Promise<void> {
    const attempts = entry.attempts + 1;
    const message = errorMessage(error);
    if (attempts >= WAKE_QUEUE_MAX_ATTEMPTS) {
      const failed: WakeQueueEntry = { ...entry, attempts };
      await this.#archive(failed, "failed", message);
      this.#emit({ kind: "wake.failed", id: entry.id, at: entry.at, attempts, message });
      const sink = this.#onDeadLetter;
      if (sink !== undefined) {
        try {
          sink(failed, error);
        } catch {
          // 死信回调自炸不得影响归档
        }
      }
      this.#arm();
      return;
    }
    const retry: WakeQueueEntry = { ...entry, at: this.#nowMs() + WAKE_QUEUE_RETRY_MS, attempts };
    await this.#requeue(retry);
    this.#arm();
  }

  async #requeue(entry: WakeQueueEntry): Promise<void> {
    try {
      await this.#serial(async () => {
        await this.#ensureLoaded();
        const next = sortEntries([...this.#entries.filter((item) => item.id !== entry.id), entry]);
        this.#writeState(next, this.#delivered, this.#legacyMigratedAt);
        this.#entries = next;
      });
    } catch (error) {
      this.#emit({ kind: "error", operation: "wake-requeue", message: errorMessage(error) });
    }
  }

  async #archive(
    entry: WakeQueueEntry,
    outcome: WakeQueueDeliveryOutcome,
    error?: string,
  ): Promise<void> {
    await this.#serial(async () => {
      await this.#ensureLoaded();
      const record: WakeQueueDelivered = {
        id: entry.id,
        at: entry.at,
        delivered_at: this.#nowMs(),
        outcome,
        ...(entry.attempts > 0 ? { attempts: entry.attempts } : {}),
        ...(error === undefined ? {} : { error }),
      };
      const delivered = [...this.#delivered, record].slice(-WAKE_QUEUE_DELIVERED_CAP);
      this.#writeState(this.#entries, delivered, this.#legacyMigratedAt);
      this.#delivered = delivered;
    });
  }

  #nowMs(): number {
    const value = this.#now();
    if (!Number.isFinite(value)) {
      throw new WakeQueueValidationError("now", `时钟必须返回有限毫秒: ${String(value)}`);
    }
    return value;
  }

  #emit(event: WakeQueueObservation): void {
    const sink = this.#observeSink;
    if (sink === undefined) return;
    try {
      sink(event);
    } catch {
      // 观察回调自炸不得影响队列主流程
    }
  }

  #signature(): bigint | null {
    try {
      return statSync(this.#paths.sidecar, { bigint: true }).mtimeNs;
    } catch {
      return null;
    }
  }

  #readSidecar(): { readonly state: QueueState; readonly corrupt: string | null } {
    let text: string;
    try {
      text = readFileSync(this.#paths.sidecar, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { state: emptyState(), corrupt: null };
      return { state: emptyState(), corrupt: errorMessage(error) };
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return { state: parseSidecar(parsed, this.#sessionID), corrupt: null };
    } catch (error) {
      return { state: emptyState(), corrupt: errorMessage(error) };
    }
  }

  /** 旧 wake/{sid}.json 只认 {sessionID, at}；损坏/不匹配 = 不迁移。 */
  #readLegacy(): number | null {
    if (!existsSync(this.#paths.legacy)) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#paths.legacy, "utf8"));
      if (!isRecord(parsed)) return null;
      if (parsed["sessionID"] !== this.#sessionID) return null;
      const at = parsed["at"];
      if (typeof at !== "number" || !Number.isFinite(at)) return null;
      return at;
    } catch (error) {
      this.#emit({ kind: "corrupt", path: this.#paths.legacy, message: errorMessage(error) });
      return null;
    }
  }

  async #load(force: boolean): Promise<WakeQueueRestoreResult> {
    if (!force && this.#loaded) return { restored: this.#entries.length, migratedLegacy: false, dropped: 0 };
    this.acquireInstanceLock();
    const now = this.#nowMs();
    const read = this.#readSidecar();
    if (read.corrupt !== null) {
      this.#emit({ kind: "corrupt", path: this.#paths.sidecar, message: read.corrupt });
    }
    let entries = [...read.state.entries];
    const delivered = [...read.state.delivered];
    let legacyMigratedAt = read.state.legacyMigratedAt;
    let migratedLegacy = false;
    let mustPersist = false;

    if (legacyMigratedAt === undefined) {
      const legacyAt = this.#readLegacy();
      if (legacyAt !== null) {
        const legacyInput: NormalizedEntryInput = {
          id: LEGACY_WAKE_ID,
          source: "special",
          action: "special.continue",
          at: legacyAt,
          payload: {},
          instruction: undefined,
          created_at: now,
          attempts: undefined,
          expires_at: undefined,
        };
        entries = [...upsertEntry(entries, delivered, legacyInput, now).entries];
        legacyMigratedAt = now;
        migratedLegacy = true;
        mustPersist = true;
      }
    }

    const retained = entries.filter((entry) => !isExpired(entry, now));
    const dropped = entries.length - retained.length;
    if (dropped > 0) {
      entries = retained;
      mustPersist = true;
    }

    if (mustPersist) {
      this.#writeState(entries, delivered, legacyMigratedAt);
      if (migratedLegacy) {
        const renamedTo = `${this.#paths.legacy}.legacy-${String(now)}`;
        try {
          renameSync(this.#paths.legacy, renamedTo);
          this.#emit({ kind: "legacy-renamed", path: this.#paths.legacy, renamedTo });
        } catch (error) {
          this.#emit({ kind: "error", operation: "legacy-rename", message: errorMessage(error) });
        }
      }
    }

    this.#entries = entries;
    this.#delivered = delivered;
    this.#legacyMigratedAt = legacyMigratedAt;
    this.#mtimeNs = this.#signature();
    this.#loaded = true;
    return { restored: entries.length, migratedLegacy, dropped };
  }

  #writeState(
    entries: readonly WakeQueueEntry[],
    delivered: readonly WakeQueueDelivered[],
    legacyMigratedAt: number | undefined,
  ): void {
    const document = {
      schema: WAKE_QUEUE_SCHEMA,
      session_id: this.#sessionID,
      entries,
      delivered,
      ...(legacyMigratedAt === undefined ? {} : { legacy_migrated_at: legacyMigratedAt }),
    };
    writeJsonAtomic(this.#paths.sidecar, document);
    this.#mtimeNs = this.#signature();
  }
}
