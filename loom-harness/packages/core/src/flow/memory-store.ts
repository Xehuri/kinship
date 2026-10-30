/**
 * MemoryFlowStore：FlowStore 的内存实现（测试/默认用；进程退出即丢）。
 *
 * 边界纪律：不可信输入先经 validation 原语解析，再经 subject-factory 投影成不可变行；
 * 本类只负责索引、容量、CAS/closed 裁决与提交路由。拒绝一律抛类型化错误。
 */

import { randomBytes } from "node:crypto";
import { FLOW_LIMITS, type FlowLimits } from "./limits.js";
import {
  FlowClosedError,
  FlowConflictError,
  FlowLimitError,
  FlowNotFoundError,
  FlowValidationError,
  type FlowStore,
} from "./store.js";
import {
  buildSubject,
  buildUpdatedSubject,
  type SubjectPlanDraft,
  type SubjectUpdateContext,
} from "./subject-factory.js";
import {
  appendNotes,
  requireFocus,
  requireKind,
  requireNow,
  requireSessionId,
  requireState,
  requireSubjectId,
  requireSubjectName,
  requireTurnIdx,
  requireVersion,
  requireWorkspaceRef,
  resolveSchedule,
  resolveTimezone,
} from "./validation.js";
import {
  DEFAULT_FLOW_SUBJECT_NAME,
  FLOW_SUBJECT_SCHEMA,
  isFlowUnsetReason,
  type FlowCommitInput,
  type FlowCommitOptions,
  type FlowCommitResult,
  type FlowCommitStamp,
  type FlowDefaultOptions,
  type FlowState,
  type FlowSubject,
  type FlowUnsetInput,
  type FlowUnsetRecord,
} from "./types.js";

const SUBJECT_ID_RE = /^flow_[0-9a-f]{12}$/;
const EMPTY_SUBJECTS: ReadonlyMap<string, FlowSubject> = new Map<string, FlowSubject>();

export interface MemoryFlowStoreOptions {
  /** 时钟注入（测试固定 now）；缺省 Date.now。 */
  readonly now?: () => number;
  /** subject_id 生成器；缺省 crypto 随机 6 字节转 12 位十六进制。 */
  readonly idFactory?: () => string;
  /**
   * 仅用于重启水合（JSON store）：按数组顺序装载既有主体；
   * 每一项都经与写路径同等强度的校验，非法即抛类型化错误。
   */
  readonly initialSubjects?: readonly unknown[];
  /** 仅用于重启水合（JSON store）：按数组顺序装载既有 unset 审计行。 */
  readonly initialUnsets?: readonly unknown[];
  /** 容量与 notes 限额；缺省 = FLOW_LIMITS（冻结缺省）。 */
  readonly limits?: FlowLimits;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new FlowValidationError(field, "必须是字符串");
  return value;
}

function readNonEmptyText(value: unknown, field: string): string {
  const text = readText(value, field);
  if (text.trim() === "") throw new FlowValidationError(field, "必须是非空字符串");
  return text;
}

function readFinite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FlowValidationError(field, "必须是有限毫秒");
  }
  return value;
}

function readNullableFinite(value: unknown, field: string): number | null {
  return value === null ? null : readFinite(value, field);
}

function readVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new FlowValidationError("version", "必须是 >=1 的整数");
  }
  return value;
}

function readTurnIdx(value: unknown, field = "turn_idx"): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new FlowValidationError(field, "必须是 >=0 的整数");
  }
  return value;
}

function readSubjectId(value: unknown): string {
  const id = readText(value, "subject_id");
  if (!SUBJECT_ID_RE.test(id)) {
    throw new FlowValidationError("subject_id", `非法 subject_id: ${id}`);
  }
  return id;
}

function hydrateStamp(raw: unknown): FlowCommitStamp {
  if (!isPlainRecord(raw)) {
    throw new FlowValidationError("last_commit", "必须是对象或 null");
  }
  return Object.freeze({
    turn_idx: readTurnIdx(raw.turn_idx, "last_commit.turn_idx"),
    at: readFinite(raw.at, "last_commit.at"),
  });
}

/** 水合主体：形状与写路径同源（validation 原语 + 限额），非法即拒绝。 */
function hydrateSubject(raw: unknown, index: number, limits: FlowLimits): FlowSubject {
  if (!isPlainRecord(raw)) {
    throw new FlowValidationError("subject", `第 ${index} 项不是对象`);
  }
  if (raw.schema !== FLOW_SUBJECT_SCHEMA) {
    throw new FlowValidationError("schema", `不支持的主体 schema: ${String(raw.schema)}`);
  }
  const notesRaw = raw.notes;
  if (!Array.isArray(notesRaw)) {
    throw new FlowValidationError("notes", "必须是字符串数组");
  }
  const notes = appendNotes([], notesRaw, limits);
  const lastCommit = raw.last_commit === null ? null : hydrateStamp(raw.last_commit);
  const subject: FlowSubject = {
    schema: FLOW_SUBJECT_SCHEMA,
    subject_id: readSubjectId(raw.subject_id),
    subject_name: requireSubjectName(readText(raw.subject_name, "subject_name")),
    session_id: requireSessionId(readText(raw.session_id, "session_id")),
    kind: requireKind(raw.kind),
    title: readText(raw.title, "title"),
    description: readText(raw.description, "description"),
    notes,
    notes_ref:
      raw.notes_ref === null ? null : requireWorkspaceRef(readText(raw.notes_ref, "notes_ref")),
    state: requireState(raw.state),
    focus: requireFocus(raw.focus),
    version: readVersion(raw.version),
    created_at: readFinite(raw.created_at, "created_at"),
    updated_at: readFinite(raw.updated_at, "updated_at"),
    next_decision_at: readNullableFinite(raw.next_decision_at, "next_decision_at"),
    soft_deadline: readNullableFinite(raw.soft_deadline, "soft_deadline"),
    due_at: readNullableFinite(raw.due_at, "due_at"),
    timezone: raw.timezone === null ? null : resolveTimezone(readText(raw.timezone, "timezone")),
    schedule: raw.schedule === null ? null : resolveSchedule(readText(raw.schedule, "schedule")),
    parent_id: raw.parent_id === null ? null : readSubjectId(raw.parent_id),
    closed_at: readNullableFinite(raw.closed_at, "closed_at"),
    close_reason: raw.close_reason === null ? null : readText(raw.close_reason, "close_reason"),
    last_commit: lastCommit,
  };
  return Object.freeze({
    ...subject,
    notes: Object.freeze([...notes]),
    last_commit:
      lastCommit === null ? null : Object.freeze({ turn_idx: lastCommit.turn_idx, at: lastCommit.at }),
  });
}

function hydrateUnset(raw: unknown, index: number): FlowUnsetRecord {
  if (!isPlainRecord(raw)) {
    throw new FlowValidationError("unset", `第 ${index} 项不是对象`);
  }
  if (raw.schema !== FLOW_SUBJECT_SCHEMA) {
    throw new FlowValidationError("schema", `不支持的 unset schema: ${String(raw.schema)}`);
  }
  if (!isFlowUnsetReason(raw.reason)) {
    throw new FlowValidationError("reason", `非法 reason: ${String(raw.reason)}`);
  }
  if (typeof raw.had_tool_results !== "boolean") {
    throw new FlowValidationError("had_tool_results", "必须是布尔值");
  }
  return Object.freeze({
    schema: FLOW_SUBJECT_SCHEMA,
    session_id: requireSessionId(readText(raw.session_id, "session_id")),
    at: readFinite(raw.at, "at"),
    turn_idx: readTurnIdx(raw.turn_idx),
    reason: raw.reason,
    had_tool_results: raw.had_tool_results,
  });
}

export class MemoryFlowStore implements FlowStore {
  private readonly _subjects = new Map<string, FlowSubject>();
  private readonly _bySession = new Map<string, Map<string, FlowSubject>>();
  private readonly _unsets = new Map<string, FlowUnsetRecord[]>();
  private readonly _now: () => number;
  private readonly _idFactory: () => string;
  private readonly _limits: FlowLimits;

  constructor(options: MemoryFlowStoreOptions = {}) {
    this._now = options.now ?? Date.now;
    this._idFactory =
      options.idFactory ?? (() => `flow_${randomBytes(6).toString("hex")}`);
    this._limits = options.limits ?? FLOW_LIMITS;
    if (options.initialSubjects !== undefined) {
      this._hydrateSubjects(options.initialSubjects);
    }
    if (options.initialUnsets !== undefined) {
      this._hydrateUnsets(options.initialUnsets);
    }
  }

  private _hydrateSubjects(rows: readonly unknown[]): void {
    const prepared: FlowSubject[] = [];
    const seenIds = new Set<string>();
    const perSession = new Map<string, FlowSubject[]>();
    for (let index = 0; index < rows.length; index += 1) {
      const subject = hydrateSubject(rows[index], index, this._limits);
      if (seenIds.has(subject.subject_id)) {
        throw new FlowValidationError("subject_id", `水合主体重复: ${subject.subject_id}`);
      }
      seenIds.add(subject.subject_id);
      const sessionRows = perSession.get(subject.session_id) ?? [];
      if (sessionRows.some((row) => row.subject_name === subject.subject_name)) {
        throw new FlowValidationError(
          "subject_name",
          `session ${subject.session_id} 内主体重名: ${subject.subject_name}`,
        );
      }
      sessionRows.push(subject);
      perSession.set(subject.session_id, sessionRows);
      prepared.push(subject);
    }
    for (const [sessionId, sessionRows] of perSession) {
      if (sessionRows.length > this._limits.maxSubjects) {
        throw new FlowLimitError("maxSubjects", this._limits.maxSubjects, sessionRows.length);
      }
      const active = sessionRows.filter((row) => row.state === "active").length;
      const waiting = sessionRows.filter(
        (row) => row.state === "waiting_user" || row.state === "waiting_event",
      ).length;
      if (active > this._limits.maxActive) {
        throw new FlowLimitError("maxActive", this._limits.maxActive, active);
      }
      if (waiting > this._limits.maxWaiting) {
        throw new FlowLimitError("maxWaiting", this._limits.maxWaiting, waiting);
      }
    }
    for (const subject of prepared) {
      this._subjects.set(subject.subject_id, subject);
      this._mutableSession(subject.session_id).set(subject.subject_id, subject);
    }
  }

  private _hydrateUnsets(rows: readonly unknown[]): void {
    for (let index = 0; index < rows.length; index += 1) {
      const record = hydrateUnset(rows[index], index);
      let sessionRows = this._unsets.get(record.session_id);
      if (sessionRows === undefined) {
        sessionRows = [];
        this._unsets.set(record.session_id, sessionRows);
      }
      sessionRows.push(record);
    }
  }

  async list(sessionId: string): Promise<readonly FlowSubject[]> {
    return [...this._session(requireSessionId(sessionId)).values()];
  }

  async get(subjectId: string): Promise<FlowSubject | null> {
    if (typeof subjectId !== "string" || subjectId.trim() === "") return null;
    return this._subjects.get(subjectId) ?? null;
  }

  async findByName(sessionId: string, subjectName: string): Promise<FlowSubject | null> {
    const sid = requireSessionId(sessionId);
    return this._findByName(sid, requireSubjectName(subjectName));
  }

  async ensureDefault(
    sessionId: string,
    options: FlowDefaultOptions = {},
  ): Promise<FlowSubject | null> {
    const sid = requireSessionId(sessionId);
    const existing = this._findByName(sid, DEFAULT_FLOW_SUBJECT_NAME);
    if (existing !== null) return existing;
    if (this._session(sid).size > 0) return null;
    return this._create({
      sessionId: sid,
      subjectName: DEFAULT_FLOW_SUBJECT_NAME,
      input: { state: "active" },
      state: "active",
      focus: "foreground",
      kind: "thread",
      now: requireNow(options.now ?? this._now()),
      turnIdx: null,
    });
  }

  async commit(
    sessionId: string,
    input: FlowCommitInput,
    options: FlowCommitOptions,
  ): Promise<FlowCommitResult> {
    const sid = requireSessionId(sessionId);
    const now = requireNow(options.now ?? this._now());
    const turnIdx = requireTurnIdx(options.turn_idx);
    const state = requireState(input.state);
    const focus = input.focus === undefined ? undefined : requireFocus(input.focus);
    const kind = input.kind === undefined ? undefined : requireKind(input.kind);
    if (input.expected_version !== undefined) {
      requireVersion(input.expected_version, "expected_version");
    }

    if (input.subject_id !== undefined) {
      const subjectId = requireSubjectId(input.subject_id);
      const subject = this._subjects.get(subjectId);
      if (subject === undefined || subject.session_id !== sid) {
        throw new FlowNotFoundError(subjectId);
      }
      if (input.subject_name !== undefined && input.subject_name !== subject.subject_name) {
        throw new FlowValidationError("subject_name", "subject_name 不可变");
      }
      return {
        subject: this._update(subject, input, {
          state,
          focus,
          kind,
          now,
          turnIdx,
          limits: this._limits,
        }),
        created: false,
      };
    }

    if (input.subject_name !== undefined) {
      const name = requireSubjectName(input.subject_name);
      const existing = this._findByName(sid, name);
      if (existing !== null) return { subject: existing, created: false };
      return {
        subject: this._create({
          sessionId: sid,
          subjectName: name,
          input,
          state,
          focus,
          kind,
          now,
          turnIdx,
        }),
        created: true,
      };
    }

    const existingDefault = this._findByName(sid, DEFAULT_FLOW_SUBJECT_NAME);
    if (existingDefault !== null) return { subject: existingDefault, created: false };
    if (this._session(sid).size > 0) {
      throw new FlowValidationError(
        "subject_name",
        "会话已有 subject，commit 必须给出 subject_id 或 subject_name",
      );
    }
    return {
      subject: this._create({
        sessionId: sid,
        subjectName: DEFAULT_FLOW_SUBJECT_NAME,
        input,
        state,
        focus,
        kind,
        now,
        turnIdx,
      }),
      created: true,
    };
  }

  async appendUnset(sessionId: string, input: FlowUnsetInput): Promise<FlowUnsetRecord> {
    const sid = requireSessionId(sessionId);
    const turnIdx = requireTurnIdx(input.turn_idx);
    if (!isFlowUnsetReason(input.reason)) {
      throw new FlowValidationError("reason", `非法 reason: ${String(input.reason)}`);
    }
    if (typeof input.had_tool_results !== "boolean") {
      throw new FlowValidationError("had_tool_results", "必须是布尔值");
    }
    const at = input.now ?? this._now();
    if (!Number.isFinite(at)) {
      throw new FlowValidationError("at", "必须是有限毫秒");
    }
    const record: FlowUnsetRecord = Object.freeze({
      schema: FLOW_SUBJECT_SCHEMA,
      session_id: sid,
      at,
      turn_idx: turnIdx,
      reason: input.reason,
      had_tool_results: input.had_tool_results,
    });
    let records = this._unsets.get(sid);
    if (records === undefined) {
      records = [];
      this._unsets.set(sid, records);
    }
    records.push(record);
    return record;
  }

  async listSessionIds(): Promise<readonly string[]> {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const id of this._bySession.keys()) {
      ids.push(id);
      seen.add(id);
    }
    for (const id of this._unsets.keys()) {
      if (!seen.has(id)) ids.push(id);
    }
    return ids;
  }

  async earliestPending(sessionId: string, now = this._now()): Promise<FlowSubject | null> {
    const sid = requireSessionId(sessionId);
    if (!Number.isFinite(now)) {
      throw new FlowValidationError("now", "必须是有限毫秒");
    }
    let best: FlowSubject | null = null;
    let bestAt = 0;
    for (const subject of this._session(sid).values()) {
      const at = subject.next_decision_at;
      if (subject.state === "closed" || at === null) continue;
      if (best === null) {
        best = subject;
        bestAt = at;
        continue;
      }
      const effective = Math.max(at, now);
      const bestEffective = Math.max(bestAt, now);
      if (
        effective < bestEffective ||
        (effective === bestEffective &&
          (at < bestAt || (at === bestAt && subject.subject_id < best.subject_id)))
      ) {
        best = subject;
        bestAt = at;
      }
    }
    return best;
  }

  private _session(sessionId: string): ReadonlyMap<string, FlowSubject> {
    return this._bySession.get(sessionId) ?? EMPTY_SUBJECTS;
  }

  private _mutableSession(sessionId: string): Map<string, FlowSubject> {
    let session = this._bySession.get(sessionId);
    if (session === undefined) {
      session = new Map();
      this._bySession.set(sessionId, session);
    }
    return session;
  }

  private _findByName(sessionId: string, name: string): FlowSubject | null {
    for (const subject of this._session(sessionId).values()) {
      if (subject.subject_name === name) return subject;
    }
    return null;
  }

  private _newSubjectId(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = this._idFactory();
      if (!SUBJECT_ID_RE.test(id)) {
        throw new Error(`idFactory 返回非法 subject_id: ${String(id)}`);
      }
      if (!this._subjects.has(id)) return id;
    }
    throw new Error("无法生成唯一 subject_id");
  }

  /** 容量校验：创建时 total + 1；state 变化时排除旧行再计入新状态。 */
  private _assertCapacity(
    sessionId: string,
    nextState: FlowState,
    excludeId: string | null,
    creating: boolean,
  ): void {
    if (creating) {
      const actual = this._session(sessionId).size + 1;
      if (actual > this._limits.maxSubjects) {
        throw new FlowLimitError("maxSubjects", this._limits.maxSubjects, actual);
      }
    }
    let active = 0;
    let waiting = 0;
    for (const subject of this._session(sessionId).values()) {
      if (excludeId !== null && subject.subject_id === excludeId) continue;
      if (subject.state === "active") active += 1;
      else if (subject.state === "waiting_user" || subject.state === "waiting_event") {
        waiting += 1;
      }
    }
    if (nextState === "active" && active + 1 > this._limits.maxActive) {
      throw new FlowLimitError("maxActive", this._limits.maxActive, active + 1);
    }
    if (
      (nextState === "waiting_user" || nextState === "waiting_event") &&
      waiting + 1 > this._limits.maxWaiting
    ) {
      throw new FlowLimitError("maxWaiting", this._limits.maxWaiting, waiting + 1);
    }
  }

  private _create(plan: SubjectPlanDraft): FlowSubject {
    this._assertCapacity(plan.sessionId, plan.state, null, true);
    const subject = buildSubject({
      ...plan,
      subjectId: this._newSubjectId(),
      limits: this._limits,
    });
    const session = this._mutableSession(plan.sessionId);
    session.set(subject.subject_id, subject);
    this._subjects.set(subject.subject_id, subject);
    return subject;
  }

  private _update(
    subject: FlowSubject,
    input: FlowCommitInput,
    context: SubjectUpdateContext,
  ): FlowSubject {
    if (subject.state === "closed") {
      throw new FlowClosedError(subject.subject_id, subject.closed_at);
    }
    const expected = input.expected_version;
    if (expected === undefined) {
      throw new FlowValidationError("expected_version", "更新必须提供 expected_version");
    }
    if (expected !== subject.version) {
      throw new FlowConflictError(subject.subject_id, expected, subject.version);
    }
    if (context.state !== subject.state) {
      this._assertCapacity(subject.session_id, context.state, subject.subject_id, false);
    }
    const next = buildUpdatedSubject(subject, input, context);
    this._mutableSession(subject.session_id).set(subject.subject_id, next);
    this._subjects.set(subject.subject_id, next);
    return next;
  }
}
