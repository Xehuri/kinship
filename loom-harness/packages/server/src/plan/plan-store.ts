/**
 * PlanStore 协议 + v1 schema 校验（Todo 9）。
 *
 * 真源只有 `plan-{date}.json`；`计划-{date}.md` 是派生渲染，
 * `plan-{date}.audit.jsonl` 是只追加审计。本文件不碰磁盘，只定义
 * 类型、类型化错误、纯校验与纯修订/收口函数，磁盘实现见 json-plan-store.ts。
 *
 * 所有语义错误（用户输入、schema 不一致、路径穿越）都必须抛类型化错误，
 * 禁止裸 Error 穿透给工具层。
 */

export const PLAN_SCHEMA = 1 as const;
export const PLAN_DEFAULT_REVIEW_AT = "07:30";

export const PLAN_STATUSES = ["draft", "committed", "closed"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** revise 只能落到 draft/committed；closed 是 close 的唯一结局。 */
export const PLAN_REVISE_STATUSES = ["draft", "committed"] as const;
export type PlanReviseStatus = (typeof PLAN_REVISE_STATUSES)[number];

export const PLAN_ITEM_KINDS = ["care", "coverage", "review", "long_task", "note"] as const;
export type PlanItemKind = (typeof PLAN_ITEM_KINDS)[number];

export const PLAN_ITEM_STATUSES = ["planned", "done", "skipped", "carried", "blocked"] as const;
export type PlanItemStatus = (typeof PLAN_ITEM_STATUSES)[number];

/** 收口时仍未完成的条目会统一转成 carried 并原样返回。 */
export const PLAN_UNFINISHED_STATUSES = ["planned", "skipped", "blocked"] as const;

export const PLAN_COVERAGE_PROFILES = ["merged_7", "merged_6"] as const;
export type PlanCoverageProfile = (typeof PLAN_COVERAGE_PROFILES)[number];

export const PLAN_AUDIT_ACTIONS = ["write", "revise", "close"] as const;
export type PlanAuditAction = (typeof PLAN_AUDIT_ACTIONS)[number];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const DOCUMENT_KEYS = [
  "schema",
  "date",
  "status",
  "version",
  "created_at",
  "updated_at",
  "review_at",
  "items",
  "coverage",
  "notes",
] as const;

const ITEM_KEYS = [
  "id",
  "kind",
  "intent",
  "status",
  "target_date",
  "window",
  "checkpoint_id",
  "done_when",
  "not_do",
  "source",
  "note",
] as const;

const COVERAGE_KEYS = ["profile", "checkpoints", "debt"] as const;

/** 输入形状/语义非法（字段缺失、枚举越界、日期/路径穿越、schema 不符）。 */
export class PlanValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`[plan:validation] ${field}: ${message}`);
    this.name = "PlanValidationError";
    this.field = field;
  }
}

/** 乐观并发冲突：expectedVersion 与磁盘当前 version 不符，本次写入未生效。 */
export class PlanConflictError extends Error {
  readonly date: string;
  readonly expected: number;
  readonly actual: number;
  constructor(date: string, expected: number, actual: number) {
    super(`[plan:conflict] date ${date} expected version ${expected}, actual ${actual}`);
    this.name = "PlanConflictError";
    this.date = date;
    this.expected = expected;
    this.actual = actual;
  }
}

/** 当日计划文件不存在。 */
export class PlanNotFoundError extends Error {
  readonly date: string;
  constructor(date: string) {
    super(`[plan:not-found] date ${date}`);
    this.name = "PlanNotFoundError";
    this.date = date;
  }
}

/** 已 closed 的计划只读；revise/close 一律拒绝。 */
export class PlanClosedError extends Error {
  readonly date: string;
  constructor(date: string) {
    super(`[plan:closed] date ${date} is closed`);
    this.name = "PlanClosedError";
    this.date = date;
  }
}

export interface PlanItem {
  readonly id: string;
  readonly kind: PlanItemKind;
  readonly intent: string;
  readonly status: PlanItemStatus;
  readonly target_date?: string;
  readonly window?: string;
  readonly checkpoint_id?: string;
  readonly done_when?: string;
  readonly not_do?: readonly string[];
  readonly source?: string;
  readonly note?: string;
}

export interface PlanCoverage {
  readonly profile: PlanCoverageProfile;
  readonly checkpoints: readonly string[];
  readonly debt: readonly string[];
}

export interface PlanDocument {
  readonly schema: typeof PLAN_SCHEMA;
  readonly date: string;
  readonly status: PlanStatus;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly review_at: string;
  readonly items: readonly PlanItem[];
  readonly coverage: PlanCoverage;
  readonly notes: readonly string[];
}

/** write() 的输入：schema/version/timestamps 由 store 生成，调用方不得注入。 */
export interface PlanWriteInput {
  readonly date: string;
  readonly status?: PlanStatus;
  readonly review_at?: string;
  readonly items: readonly PlanItem[];
  readonly coverage: PlanCoverage;
  readonly notes?: readonly string[];
}

/** 整块 patch 语义（items 是整表替换）。 */
export interface PlanPatch {
  readonly status?: PlanReviseStatus;
  readonly review_at?: string;
  readonly items?: readonly PlanItem[];
  readonly coverage?: PlanCoverage;
  readonly notes_append?: readonly string[];
}

/** 增量 ops 语义（按顺序应用，适合只改一个检查点）。 */
export type PlanReviseOp =
  | { readonly op: "set_status"; readonly status: PlanReviseStatus }
  | { readonly op: "set_review_at"; readonly review_at: string }
  | { readonly op: "upsert_item"; readonly item: PlanItem }
  | { readonly op: "remove_item"; readonly id: string }
  | { readonly op: "set_coverage"; readonly coverage: PlanCoverage }
  | { readonly op: "append_note"; readonly note: string };

export type PlanReviseInput = PlanPatch | readonly PlanReviseOp[];

export interface PlanCloseResult {
  readonly plan: PlanDocument;
  readonly carried: readonly PlanItem[];
  readonly summary: string;
}

export interface PlanAuditInput {
  readonly action: PlanAuditAction;
  readonly version: number;
  readonly expected_version?: number;
  readonly reason?: string;
  readonly at?: number;
}

export interface PlanAuditRecord {
  readonly schema: typeof PLAN_SCHEMA;
  readonly date: string;
  readonly action: PlanAuditAction;
  readonly at: number;
  readonly version: number;
  readonly expected_version: number | null;
  readonly reason: string | null;
}

export interface PlanStore {
  /** 读取当日计划；不存在抛 PlanNotFoundError，schema 损坏抛 PlanValidationError。 */
  read(date: string): Promise<PlanDocument>;
  /** 创建 version 1；同名计划已存在抛 PlanConflictError。 */
  write(plan: PlanWriteInput): Promise<PlanDocument>;
  /** CAS 修订；expectedVersion 不符抛 PlanConflictError，closed 抛 PlanClosedError。 */
  revise(
    date: string,
    expectedVersion: number,
    patchOrOps: PlanReviseInput,
    reason: string,
  ): Promise<PlanDocument>;
  /** CAS 收口；未完成条目转为 carried 并返回。 */
  close(date: string, expectedVersion: number, summary: string): Promise<PlanCloseResult>;
  /** 追加一行审计；不要求计划文件已存在。 */
  appendAudit(date: string, entry: PlanAuditInput): Promise<PlanAuditRecord>;
}

/* ───────────────────────── 基础校验 ───────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new PlanValidationError(field, `必须是对象: ${describe(value)}`);
  }
  return value;
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function assertKnownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const known = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw new PlanValidationError(`${field}.${key}`, "未知字段（schema v1 不接受扩展键）");
    }
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PlanValidationError(field, `必须是非空字符串: ${describe(value)}`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, field);
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new PlanValidationError(
      field,
      `必须是 ${allowed.join(" | ")} 之一: ${describe(value)}`,
    );
  }
  return value as T;
}

function requireTimestamp(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new PlanValidationError(field, `必须是非负整数毫秒时间戳: ${describe(value)}`);
  }
  return value;
}

function requireStringArray(
  value: unknown,
  field: string,
  options: { readonly allowEmpty: boolean; readonly unique: boolean },
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new PlanValidationError(field, `必须是字符串数组: ${describe(value)}`);
  }
  if (!options.allowEmpty && value.length === 0) {
    throw new PlanValidationError(field, "至少需要一个元素");
  }
  const rows: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const row = requireNonEmptyString(value[index], `${field}[${String(index)}]`);
    if (options.unique && seen.has(row)) {
      throw new PlanValidationError(field, `重复元素: ${row}`);
    }
    seen.add(row);
    rows.push(row);
  }
  return rows;
}

function assertUniqueIds(ids: readonly string[], field: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new PlanValidationError(field, `重复 id: ${id}`);
    seen.add(id);
  }
}

/** 严格 YYYY-MM-DD，同时拒绝 2026-02-30 这类日历越界值。 */
export function requirePlanDate(value: unknown, field = "date"): string {
  if (typeof value !== "string") {
    throw new PlanValidationError(field, `必须是 YYYY-MM-DD 字符串: ${describe(value)}`);
  }
  const match = DATE_RE.exec(value);
  if (match === null) {
    throw new PlanValidationError(field, `必须是 YYYY-MM-DD: ${value}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const stamp = new Date(Date.UTC(year, month - 1, day));
  if (
    stamp.getUTCFullYear() !== year ||
    stamp.getUTCMonth() !== month - 1 ||
    stamp.getUTCDate() !== day
  ) {
    throw new PlanValidationError(field, `不是有效日期: ${value}`);
  }
  return value;
}

export function requireReviewAt(value: unknown, field = "review_at"): string {
  if (typeof value !== "string" || !TIME_RE.test(value)) {
    throw new PlanValidationError(field, `必须是 HH:MM（00:00-23:59）: ${describe(value)}`);
  }
  return value;
}

export function requireExpectedVersion(value: unknown, field = "expected_version"): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new PlanValidationError(field, `必须是 >=1 的整数: ${describe(value)}`);
  }
  return value;
}

export function requireReason(value: unknown): string {
  return requireNonEmptyString(value, "reason");
}

/* ───────────────────────── schema 校验 ───────────────────────── */

export function requirePlanItem(value: unknown, field = "item"): PlanItem {
  const record = requireRecord(value, field);
  assertKnownKeys(record, ITEM_KEYS, field);

  const id = requireNonEmptyString(record["id"], `${field}.id`);
  if (!ITEM_ID_RE.test(id)) {
    throw new PlanValidationError(`${field}.id`, `必须匹配 ${ITEM_ID_RE.source}: ${id}`);
  }
  const kind = requireEnum(record["kind"], PLAN_ITEM_KINDS, `${field}.kind`);
  const intent = requireNonEmptyString(record["intent"], `${field}.intent`);
  const status = requireEnum(record["status"], PLAN_ITEM_STATUSES, `${field}.status`);

  const rawTargetDate = record["target_date"];
  let targetDate: string | undefined;
  if (rawTargetDate !== undefined) {
    targetDate = requirePlanDate(rawTargetDate, `${field}.target_date`);
  }
  const window = optionalNonEmptyString(record["window"], `${field}.window`);
  const checkpointId = optionalNonEmptyString(
    record["checkpoint_id"],
    `${field}.checkpoint_id`,
  );
  if (checkpointId !== undefined && !ITEM_ID_RE.test(checkpointId)) {
    throw new PlanValidationError(
      `${field}.checkpoint_id`,
      `必须匹配 ${ITEM_ID_RE.source}: ${checkpointId}`,
    );
  }
  const doneWhen = optionalNonEmptyString(record["done_when"], `${field}.done_when`);
  const notDoRaw = record["not_do"];
  const notDo =
    notDoRaw === undefined
      ? undefined
      : requireStringArray(notDoRaw, `${field}.not_do`, { allowEmpty: true, unique: true });
  const source = optionalNonEmptyString(record["source"], `${field}.source`);
  const note = optionalNonEmptyString(record["note"], `${field}.note`);

  return {
    id,
    kind,
    intent,
    status,
    ...(targetDate === undefined ? {} : { target_date: targetDate }),
    ...(window === undefined ? {} : { window }),
    ...(checkpointId === undefined ? {} : { checkpoint_id: checkpointId }),
    ...(doneWhen === undefined ? {} : { done_when: doneWhen }),
    ...(notDo === undefined ? {} : { not_do: notDo }),
    ...(source === undefined ? {} : { source }),
    ...(note === undefined ? {} : { note }),
  };
}

export function requirePlanCoverage(value: unknown, field = "coverage"): PlanCoverage {
  const record = requireRecord(value, field);
  assertKnownKeys(record, COVERAGE_KEYS, field);
  const profile = requireEnum(record["profile"], PLAN_COVERAGE_PROFILES, `${field}.profile`);
  const checkpoints = requireStringArray(record["checkpoints"], `${field}.checkpoints`, {
    allowEmpty: false,
    unique: true,
  });
  const debt = requireStringArray(record["debt"], `${field}.debt`, {
    allowEmpty: true,
    unique: true,
  });
  return { profile, checkpoints, debt };
}

/** 从磁盘/任意 unknown 解析一份完整计划；expectedDate 用于防串日。 */
export function validatePlanDocument(value: unknown, expectedDate?: string): PlanDocument {
  const record = requireRecord(value, "plan");
  assertKnownKeys(record, DOCUMENT_KEYS, "plan");

  const schema = record["schema"];
  if (schema !== PLAN_SCHEMA) {
    throw new PlanValidationError("schema", `只支持 ${String(PLAN_SCHEMA)}: ${describe(schema)}`);
  }
  const date = requirePlanDate(record["date"]);
  if (expectedDate !== undefined && date !== expectedDate) {
    throw new PlanValidationError("date", `文件日期 ${date} 与请求日期 ${expectedDate} 不一致`);
  }
  const status = requireEnum(record["status"], PLAN_STATUSES, "status");
  const version = requireExpectedVersion(record["version"], "version");
  const createdAt = requireTimestamp(record["created_at"], "created_at");
  const updatedAt = requireTimestamp(record["updated_at"], "updated_at");
  if (updatedAt < createdAt) {
    throw new PlanValidationError("updated_at", "不得早于 created_at");
  }
  const reviewAt = requireReviewAt(record["review_at"]);

  const rawItems = record["items"];
  if (!Array.isArray(rawItems)) {
    throw new PlanValidationError("items", `必须是数组: ${describe(rawItems)}`);
  }
  const items = rawItems.map((entry, index) => requirePlanItem(entry, `items[${String(index)}]`));
  assertUniqueIds(
    items.map((item) => item.id),
    "items.id",
  );

  const coverage = requirePlanCoverage(record["coverage"]);
  const notes = requireStringArray(record["notes"], "notes", {
    allowEmpty: true,
    unique: false,
  });

  return {
    schema: PLAN_SCHEMA,
    date,
    status,
    version,
    created_at: createdAt,
    updated_at: updatedAt,
    review_at: reviewAt,
    items,
    coverage,
    notes,
  };
}

export interface PlanDraft {
  readonly date: string;
  readonly status: PlanStatus;
  readonly review_at: string;
  readonly items: readonly PlanItem[];
  readonly coverage: PlanCoverage;
  readonly notes: readonly string[];
}

/** write() 输入校验并补默认值：status=draft，review_at=07:30，notes=[]。 */
export function validatePlanWriteInput(value: unknown): PlanDraft {
  const record = requireRecord(value, "plan");
  assertKnownKeys(record, ["date", "status", "review_at", "items", "coverage", "notes"], "plan");
  const date = requirePlanDate(record["date"]);
  const status =
    record["status"] === undefined
      ? "draft"
      : requireEnum(record["status"], PLAN_STATUSES, "status");
  const reviewAt =
    record["review_at"] === undefined
      ? PLAN_DEFAULT_REVIEW_AT
      : requireReviewAt(record["review_at"]);
  const rawItems = record["items"];
  if (!Array.isArray(rawItems)) {
    throw new PlanValidationError("items", `必须是数组: ${describe(rawItems)}`);
  }
  const items = rawItems.map((entry, index) => requirePlanItem(entry, `items[${String(index)}]`));
  assertUniqueIds(
    items.map((item) => item.id),
    "items.id",
  );
  const coverage = requirePlanCoverage(record["coverage"]);
  const rawNotes = record["notes"];
  const notes =
    rawNotes === undefined
      ? []
      : requireStringArray(rawNotes, "notes", { allowEmpty: true, unique: false });
  return { date, status, review_at: reviewAt, items, coverage, notes };
}

/* ───────────────────────── 修订 / 收口（纯函数） ───────────────────────── */

function cloneCoverage(coverage: PlanCoverage): PlanCoverage {
  return {
    profile: coverage.profile,
    checkpoints: [...coverage.checkpoints],
    debt: [...coverage.debt],
  };
}

interface MutableDraft {
  status: PlanStatus;
  reviewAt: string;
  items: PlanItem[];
  coverage: PlanCoverage;
  notes: string[];
}

function applyPatch(draft: MutableDraft, patch: unknown): void {
  const record = requireRecord(patch, "patch");
  assertKnownKeys(record, ["status", "review_at", "items", "coverage", "notes_append"], "patch");
  const keys = Object.keys(record);
  if (keys.length === 0) {
    throw new PlanValidationError("patch", "至少需要一个修改字段");
  }

  if (record["status"] !== undefined) {
    draft.status = requireEnum(record["status"], PLAN_REVISE_STATUSES, "patch.status");
  }
  if (record["review_at"] !== undefined) {
    draft.reviewAt = requireReviewAt(record["review_at"], "patch.review_at");
  }
  if (record["items"] !== undefined) {
    const rawItems = record["items"];
    if (!Array.isArray(rawItems)) {
      throw new PlanValidationError("patch.items", `必须是数组: ${describe(rawItems)}`);
    }
    const items = rawItems.map((entry, index) =>
      requirePlanItem(entry, `patch.items[${String(index)}]`),
    );
    assertUniqueIds(
      items.map((item) => item.id),
      "patch.items.id",
    );
    draft.items = items;
  }
  if (record["coverage"] !== undefined) {
    draft.coverage = requirePlanCoverage(record["coverage"], "patch.coverage");
  }
  if (record["notes_append"] !== undefined) {
    const appended = requireStringArray(record["notes_append"], "patch.notes_append", {
      allowEmpty: true,
      unique: false,
    });
    draft.notes = [...draft.notes, ...appended];
  }
}

function applyOp(draft: MutableDraft, rawOp: unknown, index: number): void {
  const field = `ops[${String(index)}]`;
  const record = requireRecord(rawOp, field);
  const op = requireNonEmptyString(record["op"], `${field}.op`);

  switch (op) {
    case "set_status": {
      assertKnownKeys(record, ["op", "status"], field);
      draft.status = requireEnum(record["status"], PLAN_REVISE_STATUSES, `${field}.status`);
      return;
    }
    case "set_review_at": {
      assertKnownKeys(record, ["op", "review_at"], field);
      draft.reviewAt = requireReviewAt(record["review_at"], `${field}.review_at`);
      return;
    }
    case "upsert_item": {
      assertKnownKeys(record, ["op", "item"], field);
      const item = requirePlanItem(record["item"], `${field}.item`);
      const at = draft.items.findIndex((row) => row.id === item.id);
      if (at === -1) draft.items = [...draft.items, item];
      else draft.items = draft.items.map((row, rowIndex) => (rowIndex === at ? item : row));
      return;
    }
    case "remove_item": {
      assertKnownKeys(record, ["op", "id"], field);
      const id = requireNonEmptyString(record["id"], `${field}.id`);
      if (!ITEM_ID_RE.test(id)) {
        throw new PlanValidationError(`${field}.id`, `必须匹配 ${ITEM_ID_RE.source}: ${id}`);
      }
      const at = draft.items.findIndex((row) => row.id === id);
      if (at === -1) {
        throw new PlanValidationError(`${field}.id`, `条目不存在: ${id}`);
      }
      draft.items = draft.items.filter((row) => row.id !== id);
      return;
    }
    case "set_coverage": {
      assertKnownKeys(record, ["op", "coverage"], field);
      draft.coverage = requirePlanCoverage(record["coverage"], `${field}.coverage`);
      return;
    }
    case "append_note": {
      assertKnownKeys(record, ["op", "note"], field);
      draft.notes = [...draft.notes, requireNonEmptyString(record["note"], `${field}.note`)];
      return;
    }
    default:
      throw new PlanValidationError(
        `${field}.op`,
        `未知操作 ${describe(op)}，允许 set_status | set_review_at | upsert_item | remove_item | set_coverage | append_note`,
      );
  }
}

/**
 * 纯修订：版本 +1、updated_at=now，其余字段保持。closed 计划拒绝。
 * 返回值已经过完整 schema 校验，调用方只需落盘。
 */
export function revisePlanDocument(
  current: PlanDocument,
  patchOrOps: PlanReviseInput,
  now: number,
): PlanDocument {
  if (current.status === "closed") throw new PlanClosedError(current.date);
  const draft: MutableDraft = {
    status: current.status,
    reviewAt: current.review_at,
    items: [...current.items],
    coverage: cloneCoverage(current.coverage),
    notes: [...current.notes],
  };

  if (Array.isArray(patchOrOps)) {
    if (patchOrOps.length === 0) {
      throw new PlanValidationError("ops", "至少需要一个操作");
    }
    for (let index = 0; index < patchOrOps.length; index += 1) {
      applyOp(draft, patchOrOps[index], index);
    }
  } else {
    applyPatch(draft, patchOrOps);
  }

  return validatePlanDocument(
    {
      schema: PLAN_SCHEMA,
      date: current.date,
      status: draft.status,
      version: current.version + 1,
      created_at: current.created_at,
      updated_at: requireTimestamp(now, "updated_at"),
      review_at: draft.reviewAt,
      items: draft.items,
      coverage: draft.coverage,
      notes: draft.notes,
    },
    current.date,
  );
}

/**
 * 纯收口：planned/skipped/blocked -> carried，返回转写后的条目（按原顺序）。
 */
export function closePlanDocument(
  current: PlanDocument,
  now: number,
): { readonly plan: PlanDocument; readonly carried: readonly PlanItem[] } {
  if (current.status === "closed") throw new PlanClosedError(current.date);
  const carried: PlanItem[] = [];
  const items = current.items.map((item) => {
    if (!(PLAN_UNFINISHED_STATUSES as readonly string[]).includes(item.status)) return item;
    const next: PlanItem = { ...item, status: "carried" };
    carried.push(next);
    return next;
  });
  const plan = validatePlanDocument(
    {
      ...current,
      status: "closed",
      version: current.version + 1,
      updated_at: requireTimestamp(now, "updated_at"),
      items,
    },
    current.date,
  );
  return { plan, carried };
}

/* ───────────────────────── 审计校验 ───────────────────────── */

export function normalizePlanAudit(
  date: string,
  value: unknown,
  at: number,
): PlanAuditRecord {
  const day = requirePlanDate(date, "audit.date");
  const record = requireRecord(value, "audit");
  assertKnownKeys(
    record,
    ["action", "version", "expected_version", "reason", "at"],
    "audit",
  );
  const action = requireEnum(record["action"], PLAN_AUDIT_ACTIONS, "audit.action");
  const version = requireExpectedVersion(record["version"], "audit.version");
  const rawExpected = record["expected_version"];
  const expectedVersion =
    rawExpected === undefined
      ? null
      : requireExpectedVersion(rawExpected, "audit.expected_version");
  const rawReason = record["reason"];
  const reason =
    rawReason === undefined ? null : requireNonEmptyString(rawReason, "audit.reason");
  const stamp =
    record["at"] === undefined ? requireTimestamp(at, "audit.at") : requireTimestamp(record["at"], "audit.at");
  return {
    schema: PLAN_SCHEMA,
    date: day,
    action,
    at: stamp,
    version,
    expected_version: expectedVersion,
    reason,
  };
}
