/**
 * 简化持续记录 store 协议（Todo 25）：每个 plan 条目最多一条记录。
 *
 * 与多主体 FlowStore 并存：旧 `flow/subjects/` 继续只读，新记录走
 * `flow/items/{id}.json`。本模块提供类型化错误、输入/水合校验与内存实现；
 * 磁盘实现（JsonFlowContinuationStore）复用同一套语义。
 *
 * 拒绝纪律：校验/冲突/不存在一律抛类型化错误，工具层折叠成 isError 结果。
 */

import { FlowValidationError } from "./store.js";
import { resolveNextDecisionAt } from "./time.js";
import { requireNow, requireSessionId } from "./validation.js";
import {
  FLOW_CONTINUATION_SCHEMA,
  isFlowContinuationState,
  type FlowContinuation,
  type FlowContinuationSource,
  type FlowTimeInput,
} from "./types.js";

const CONTINUATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PLAN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_KEYS = new Set(["plan_date", "checkpoint_id", "open_loop_id"]);

/** 同一 id 或同一条目已有未关闭持续记录。 */
export class FlowContinuationConflictError extends Error {
  readonly id: string;
  constructor(id: string, message: string) {
    super(`[flow:item-conflict] ${id}: ${message}`);
    this.name = "FlowContinuationConflictError";
    this.id = id;
  }
}

/** 持续记录不存在（或不属于该 session）。 */
export class FlowContinuationNotFoundError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`[flow:item-not-found] ${id}`);
    this.name = "FlowContinuationNotFoundError";
    this.id = id;
  }
}

export interface FlowContinuationCreateInput {
  readonly id: string;
  readonly source?: FlowContinuationSource;
  readonly waiting_on: string;
  readonly next_at: FlowTimeInput;
  readonly close_condition?: string | null;
  readonly reason?: string | null;
}

export type FlowContinuationWaitInput = FlowContinuationCreateInput;

export interface FlowContinuationResumeInput {
  readonly id: string;
  readonly reason?: string | null;
}

export interface FlowContinuationCloseInput {
  readonly id: string;
  readonly reason: string;
}

export interface FlowContinuationStore {
  /** 严格创建：同 id 或同一条目已有未关闭记录时冲突。 */
  create(
    sessionId: string,
    input: FlowContinuationCreateInput,
  ): Promise<FlowContinuation>;
  /** 创建或更新：同 id 更新；同一条目换 id 新建时冲突；已关闭拒绝。 */
  wait(
    sessionId: string,
    input: FlowContinuationWaitInput,
  ): Promise<FlowContinuation>;
  /** waiting/active -> active；closed 拒绝。 */
  resume(
    sessionId: string,
    input: FlowContinuationResumeInput,
  ): Promise<FlowContinuation>;
  /** 必须给非空 reason；closed 拒绝二次关闭。 */
  close(
    sessionId: string,
    input: FlowContinuationCloseInput,
  ): Promise<FlowContinuation>;
  read(sessionId: string, id: string): Promise<FlowContinuation>;
  list(sessionId: string): Promise<readonly FlowContinuation[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireContinuationId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !CONTINUATION_ID_RE.test(value)
  ) {
    throw new FlowValidationError(
      "id",
      `必须匹配 ${CONTINUATION_ID_RE.source}: ${String(value)}`,
    );
  }
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new FlowValidationError(field, "必须是非空字符串");
  }
  return value;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requireText(value, field);
}

export function normalizeContinuationSource(
  raw: unknown,
): FlowContinuationSource {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) {
    throw new FlowValidationError("source", "必须是对象");
  }
  for (const key of Object.keys(raw)) {
    if (!SOURCE_KEYS.has(key)) {
      throw new FlowValidationError("source", `不支持的字段: ${key}`);
    }
  }
  let planDate: string | undefined;
  let checkpointId: string | undefined;
  let openLoopId: string | undefined;
  const rawPlanDate = raw["plan_date"];
  const rawCheckpointId = raw["checkpoint_id"];
  const rawOpenLoopId = raw["open_loop_id"];
  if (rawPlanDate !== undefined) {
    if (typeof rawPlanDate !== "string" || !PLAN_DATE_RE.test(rawPlanDate)) {
      throw new FlowValidationError("source.plan_date", "必须是 YYYY-MM-DD");
    }
    planDate = rawPlanDate;
  }
  if (rawCheckpointId !== undefined) {
    checkpointId = requireContinuationId(rawCheckpointId);
  }
  if (rawOpenLoopId !== undefined) {
    openLoopId = requireContinuationId(rawOpenLoopId);
  }
  if (checkpointId !== undefined && openLoopId !== undefined) {
    throw new FlowValidationError(
      "source",
      "checkpoint_id 与 open_loop_id 只能二选一",
    );
  }
  return Object.freeze({
    ...(planDate === undefined ? {} : { plan_date: planDate }),
    ...(checkpointId === undefined ? {} : { checkpoint_id: checkpointId }),
    ...(openLoopId === undefined ? {} : { open_loop_id: openLoopId }),
  });
}

function sourceKey(source: FlowContinuationSource): string | null {
  const itemId = source.checkpoint_id ?? source.open_loop_id;
  if (itemId === undefined) return null;
  return `${source.plan_date ?? ""}|${itemId}`;
}

function sameSource(
  left: FlowContinuationSource,
  right: FlowContinuationSource,
): boolean {
  return (
    left.plan_date === right.plan_date &&
    left.checkpoint_id === right.checkpoint_id &&
    left.open_loop_id === right.open_loop_id
  );
}

function resolveNextAt(value: FlowTimeInput, now: number): number {
  const resolved = resolveNextDecisionAt(value, now);
  if (!resolved.ok) {
    throw new FlowValidationError("next_at", resolved.reason);
  }
  if (resolved.at === null) {
    throw new FlowValidationError("next_at", "wait 必须给出 next_at");
  }
  return resolved.at;
}

function buildRecord(input: {
  readonly id: string;
  readonly source: FlowContinuationSource;
  readonly state: FlowContinuation["state"];
  readonly waiting_on: string | null;
  readonly next_at: number | null;
  readonly close_condition: string | null;
  readonly reason: string | null;
  readonly last_update: number;
}): FlowContinuation {
  return Object.freeze({
    schema: FLOW_CONTINUATION_SCHEMA,
    id: input.id,
    source: input.source,
    state: input.state,
    waiting_on: input.waiting_on,
    next_at: input.next_at,
    close_condition: input.close_condition,
    last_update: input.last_update,
    reason: input.reason,
  });
}

function assertStateShape(record: FlowContinuation): void {
  if (record.state === "waiting") {
    if (record.waiting_on === null) {
      throw new FlowValidationError("waiting_on", "waiting 态必须非空");
    }
    if (record.next_at === null) {
      throw new FlowValidationError("next_at", "waiting 态必须非空");
    }
    return;
  }
  if (record.waiting_on !== null) {
    throw new FlowValidationError(
      "waiting_on",
      `${record.state} 态必须为 null`,
    );
  }
  if (record.next_at !== null) {
    throw new FlowValidationError("next_at", `${record.state} 态必须为 null`);
  }
  if (record.state === "closed" && record.reason === null) {
    throw new FlowValidationError("reason", "closed 态必须给出 reason");
  }
}

/** 水合一行（磁盘/初始记录）：与写路径同强度校验，非法即抛。 */
export function hydrateFlowContinuation(
  raw: unknown,
  expectedId?: string,
): FlowContinuation {
  if (!isRecord(raw)) {
    throw new FlowValidationError("continuation", "必须是对象");
  }
  if (raw["schema"] !== FLOW_CONTINUATION_SCHEMA) {
    throw new FlowValidationError(
      "schema",
      `不支持的持续记录 schema: ${String(raw["schema"])}`,
    );
  }
  const id = requireContinuationId(raw["id"]);
  if (expectedId !== undefined && expectedId !== id) {
    throw new FlowValidationError(
      "id",
      `记录 id 与路径不一致: ${id} != ${expectedId}`,
    );
  }
  const state = raw["state"];
  if (!isFlowContinuationState(state)) {
    throw new FlowValidationError("state", `非法状态: ${String(state)}`);
  }
  const lastUpdate = raw["last_update"];
  if (typeof lastUpdate !== "number" || !Number.isFinite(lastUpdate)) {
    throw new FlowValidationError("last_update", "必须是有限毫秒");
  }
  const nextAt = raw["next_at"];
  if (
    nextAt !== null &&
    (typeof nextAt !== "number" || !Number.isFinite(nextAt))
  ) {
    throw new FlowValidationError("next_at", "必须是有限毫秒或 null");
  }
  const waitingOn = raw["waiting_on"];
  const closeCondition = raw["close_condition"];
  const reason = raw["reason"];
  const record = buildRecord({
    id,
    source: normalizeContinuationSource(raw["source"]),
    state,
    waiting_on: waitingOn === null ? null : requireText(waitingOn, "waiting_on"),
    next_at: nextAt,
    close_condition:
      closeCondition === null
        ? null
        : optionalText(closeCondition, "close_condition"),
    reason: reason === null ? null : optionalText(reason, "reason"),
    last_update: lastUpdate,
  });
  assertStateShape(record);
  return record;
}

export interface MemoryFlowContinuationStoreOptions {
  /** 时钟注入（测试固定 now）；缺省 Date.now。 */
  readonly now?: () => number;
  /** 仅用于重启水合（JsonFlowContinuationStore）：按 session 分组的既有记录。 */
  readonly initialBySession?: ReadonlyMap<string, readonly unknown[]>;
}

export class MemoryFlowContinuationStore implements FlowContinuationStore {
  private readonly _bySession = new Map<
    string,
    Map<string, FlowContinuation>
  >();
  private readonly _now: () => number;

  constructor(options: MemoryFlowContinuationStoreOptions = {}) {
    this._now = options.now ?? Date.now;
    for (const [sessionId, rows] of options.initialBySession ?? []) {
      const sid = requireSessionId(sessionId);
      const session = this._mutableSession(sid);
      for (const raw of rows) {
        const record = hydrateFlowContinuation(raw);
        if (session.has(record.id)) {
          throw new FlowValidationError(
            "id",
            `水合持续记录重复: ${record.id}`,
          );
        }
        if (record.state !== "closed") {
          this._assertSourceFreeIn(session, record.source, record.id);
        }
        session.set(record.id, record);
      }
    }
  }

  async list(sessionId: string): Promise<readonly FlowContinuation[]> {
    const sid = requireSessionId(sessionId);
    return [...this._session(sid).values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  }

  async read(sessionId: string, id: string): Promise<FlowContinuation> {
    const sid = requireSessionId(sessionId);
    const record = this._session(sid).get(requireContinuationId(id));
    if (record === undefined) {
      throw new FlowContinuationNotFoundError(id);
    }
    return record;
  }

  async create(
    sessionId: string,
    input: FlowContinuationCreateInput,
  ): Promise<FlowContinuation> {
    const sid = requireSessionId(sessionId);
    const record = this._buildWaiting(input);
    const session = this._mutableSession(sid);
    if (session.has(record.id)) {
      throw new FlowContinuationConflictError(
        record.id,
        "同一 id 已存在持续记录",
      );
    }
    this._assertSourceFreeIn(session, record.source, record.id);
    session.set(record.id, record);
    return record;
  }

  async wait(
    sessionId: string,
    input: FlowContinuationWaitInput,
  ): Promise<FlowContinuation> {
    const sid = requireSessionId(sessionId);
    const id = requireContinuationId(input.id);
    const now = this._clock();
    const session = this._mutableSession(sid);
    const existing = session.get(id);
    const incomingSource =
      input.source === undefined
        ? null
        : normalizeContinuationSource(input.source);

    if (existing === undefined) {
      const created = this._buildWaiting(input, now);
      this._assertSourceFreeIn(session, created.source, created.id);
      session.set(created.id, created);
      return created;
    }

    if (existing.state === "closed") {
      throw new FlowContinuationConflictError(
        id,
        "已关闭的持续记录不能再次 wait",
      );
    }
    const source = incomingSource ?? existing.source;
    if (!sameSource(source, existing.source)) {
      throw new FlowContinuationConflictError(
        id,
        "同一 id 不能改绑到其他条目",
      );
    }
    this._assertSourceFreeIn(session, source, id);
    const next = buildRecord({
      id,
      source,
      state: "waiting",
      waiting_on: requireText(input.waiting_on, "waiting_on"),
      next_at: resolveNextAt(input.next_at, now),
      close_condition:
        input.close_condition === undefined
          ? existing.close_condition
          : optionalText(input.close_condition, "close_condition"),
      reason:
        input.reason === undefined
          ? existing.reason
          : optionalText(input.reason, "reason"),
      last_update: now,
    });
    session.set(id, next);
    return next;
  }

  async resume(
    sessionId: string,
    input: FlowContinuationResumeInput,
  ): Promise<FlowContinuation> {
    const sid = requireSessionId(sessionId);
    const id = requireContinuationId(input.id);
    const session = this._mutableSession(sid);
    const existing = session.get(id);
    if (existing === undefined) {
      throw new FlowContinuationNotFoundError(id);
    }
    if (existing.state === "closed") {
      throw new FlowContinuationConflictError(id, "已关闭的持续记录不能 resume");
    }
    const next = buildRecord({
      id,
      source: existing.source,
      state: "active",
      waiting_on: null,
      next_at: null,
      close_condition: existing.close_condition,
      reason:
        input.reason === undefined
          ? existing.reason
          : optionalText(input.reason, "reason"),
      last_update: this._clock(),
    });
    session.set(id, next);
    return next;
  }

  async close(
    sessionId: string,
    input: FlowContinuationCloseInput,
  ): Promise<FlowContinuation> {
    const sid = requireSessionId(sessionId);
    const id = requireContinuationId(input.id);
    const reason = requireText(input.reason, "reason");
    const session = this._mutableSession(sid);
    const existing = session.get(id);
    if (existing === undefined) {
      throw new FlowContinuationNotFoundError(id);
    }
    if (existing.state === "closed") {
      throw new FlowContinuationConflictError(id, "持续记录已关闭");
    }
    const next = buildRecord({
      id,
      source: existing.source,
      state: "closed",
      waiting_on: null,
      next_at: null,
      close_condition: existing.close_condition,
      reason,
      last_update: this._clock(),
    });
    session.set(id, next);
    return next;
  }

  private _buildWaiting(
    input: FlowContinuationCreateInput,
    now = this._clock(),
  ): FlowContinuation {
    return buildRecord({
      id: requireContinuationId(input.id),
      source: normalizeContinuationSource(input.source),
      state: "waiting",
      waiting_on: requireText(input.waiting_on, "waiting_on"),
      next_at: resolveNextAt(input.next_at, now),
      close_condition:
        input.close_condition === undefined
          ? null
          : optionalText(input.close_condition, "close_condition"),
      reason:
        input.reason === undefined
          ? null
          : optionalText(input.reason, "reason"),
      last_update: now,
    });
  }

  private _clock(): number {
    return requireNow(this._now());
  }

  private _session(sessionId: string): ReadonlyMap<string, FlowContinuation> {
    return this._bySession.get(sessionId) ?? new Map();
  }

  private _mutableSession(
    sessionId: string,
  ): Map<string, FlowContinuation> {
    let session = this._bySession.get(sessionId);
    if (session === undefined) {
      session = new Map();
      this._bySession.set(sessionId, session);
    }
    return session;
  }

  private _assertSourceFreeIn(
    session: Map<string, FlowContinuation>,
    source: FlowContinuationSource,
    excludeId: string,
  ): void {
    const key = sourceKey(source);
    if (key === null) return;
    for (const record of session.values()) {
      if (record.id === excludeId || record.state === "closed") continue;
      if (sourceKey(record.source) === key) {
        throw new FlowContinuationConflictError(
          record.id,
          `条目 ${key} 已有未关闭的持续记录`,
        );
      }
    }
  }
}
