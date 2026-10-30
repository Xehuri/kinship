/**
 * 日计划 diff 覆盖层（T06）：schema、纯校验、母版合并与有效视图渲染。
 *
 * 母版（master-plan）是持久真源；当日覆盖层只记录 add/update/remove/note
 * 四种差量 op，绝不回写母版。有效视图 = materializeMasterEntries(master, date)
 * 再按 id 应用覆盖层 op。本文件不碰磁盘，磁盘实现见 json-plan-overlay-store.ts。
 */

import { isWakeAction } from "./actions.js";
import {
  materializeMasterEntries,
  type MasterEntry,
  type MasterKind,
  type MasterPlanDocument,
} from "./master-plan.js";
import {
  PLAN_ITEM_KINDS,
  PLAN_ITEM_STATUSES,
  type PlanCoverage,
  type PlanItemKind,
  type PlanItemStatus,
} from "./plan-store.js";

export const OVERLAY_SCHEMA = 1 as const;
export const OVERLAY_STATUSES = ["draft", "committed", "closed"] as const;
export type PlanOverlayStatus = (typeof OVERLAY_STATUSES)[number];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const STAMP_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

const DOCUMENT_KEYS = [
  "schema",
  "kind",
  "date",
  "base_version",
  "version",
  "status",
  "created_at",
  "updated_at",
  "ops",
  "notes",
  "coverage",
  "user_intent",
] as const;
const ITEM_KEYS = [
  "id",
  "kind",
  "intent",
  "status",
  "at",
  "action",
  "payload",
  "window",
  "done_when",
  "note",
  "evidence",
  "done_at",
  "target_date",
  "checkpoint_id",
  "not_do",
] as const;
const PATCH_KEYS = [
  "at",
  "action",
  "payload",
  "intent",
  "window",
  "done_when",
  "note",
  "status",
  "evidence",
  "done_at",
] as const;
const COVERAGE_KEYS = ["profile", "checkpoints", "debt"] as const;
const COVERAGE_PROFILES = ["merged_7", "merged_6"] as const;

export interface PlanOverlayItem {
  readonly id: string;
  readonly kind: PlanItemKind;
  readonly intent: string;
  readonly status: PlanItemStatus;
  readonly at?: string;
  readonly action?: string;
  readonly payload?: unknown;
  readonly window?: string;
  readonly done_when?: string;
  readonly note?: string;
  readonly evidence?: string;
  readonly done_at?: string;
  readonly target_date?: string;
  readonly checkpoint_id?: string;
  readonly not_do?: readonly string[];
}

/** update 的局部修改；null 表示清除可选字段，status 不接受 null。 */
export interface PlanOverlayPatch {
  readonly at?: string | null;
  readonly action?: string | null;
  readonly payload?: unknown;
  readonly intent?: string | null;
  readonly window?: string | null;
  readonly done_when?: string | null;
  readonly note?: string | null;
  readonly status?: PlanItemStatus;
  readonly evidence?: string | null;
  readonly done_at?: string | null;
}

export type PlanOverlayOp =
  | { readonly op: "add"; readonly item: PlanOverlayItem }
  | { readonly op: "update"; readonly id: string; readonly patch: PlanOverlayPatch }
  | { readonly op: "remove"; readonly id: string }
  | { readonly op: "note"; readonly text: string };

export interface PlanOverlayDocument {
  readonly schema: typeof OVERLAY_SCHEMA;
  readonly kind: "plan-overlay";
  readonly date: string;
  readonly base_version: number;
  readonly version: number;
  readonly status: PlanOverlayStatus;
  readonly created_at: number;
  readonly updated_at: number;
  readonly ops: readonly PlanOverlayOp[];
  readonly notes: readonly string[];
  readonly coverage: PlanCoverage;
  readonly user_intent?: string;
}

export interface PlanOverlayWriteInput {
  readonly date: string;
  readonly base_version: number;
  readonly ops: readonly PlanOverlayOp[];
  readonly coverage: PlanCoverage;
  readonly notes?: readonly string[];
  readonly user_intent?: string;
}

export interface PlanOverlayDraft {
  readonly date: string;
  readonly base_version: number;
  readonly ops: readonly PlanOverlayOp[];
  readonly coverage: PlanCoverage;
  readonly notes: readonly string[];
  readonly user_intent?: string;
}

export interface PlanOverlayReviseInput {
  readonly base_version?: number;
  readonly ops?: readonly PlanOverlayOp[];
  readonly coverage?: PlanCoverage;
  readonly notes_append?: readonly string[];
  readonly user_intent?: string;
}

export interface EffectivePlanEntry {
  readonly id: string;
  readonly kind: MasterKind | PlanItemKind;
  readonly title?: string;
  readonly intent?: string;
  readonly at?: string;
  readonly at_override: boolean;
  readonly action?: string;
  readonly payload?: unknown;
  readonly instruction?: string;
  readonly window?: string;
  readonly done_when?: string;
  readonly target_date?: string;
  readonly checkpoint_id?: string;
  readonly not_do?: readonly string[];
  readonly note?: string;
  readonly status: PlanItemStatus;
  readonly evidence?: string;
  readonly done_at?: string;
  readonly source: "master" | "overlay";
  readonly suppressed: boolean;
  readonly master_version: number;
  readonly overlay_version: number;
}

export interface EffectivePlan {
  readonly date: string;
  readonly origin: "overlay" | "legacy";
  readonly status: PlanOverlayStatus;
  readonly base_version: number;
  readonly master_version: number;
  readonly overlay_version: number;
  readonly coverage: PlanCoverage;
  readonly entries: readonly EffectivePlanEntry[];
  readonly notes: readonly string[];
  readonly warnings: readonly string[];
  readonly user_intent?: string;
}

export class PlanOverlayValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`[plan-overlay:validation] ${field}: ${message}`);
    this.name = "PlanOverlayValidationError";
    this.field = field;
  }
}

export class OverlayBaseStaleError extends Error {
  readonly date: string;
  readonly baseVersion: number;
  readonly masterVersion: number;
  constructor(date: string, baseVersion: number, masterVersion: number) {
    super(
      `[plan-overlay:base-stale] date ${date} base_version ${String(baseVersion)} != master ${String(masterVersion)}`,
    );
    this.name = "OverlayBaseStaleError";
    this.date = date;
    this.baseVersion = baseVersion;
    this.masterVersion = masterVersion;
  }
}

export class PlanOverlayNotFoundError extends Error {
  readonly date: string;
  readonly path: string;
  constructor(date: string, path: string) {
    super(`[plan-overlay:not-found] ${path}`);
    this.name = "PlanOverlayNotFoundError";
    this.date = date;
    this.path = path;
  }
}

export class PlanOverlayConflictError extends Error {
  readonly date: string;
  readonly expected: number | null;
  readonly actual: number;
  constructor(date: string, expected: number | null, actual: number) {
    super(`[plan-overlay:conflict] date ${date} expected ${String(expected)}, actual ${String(actual)}`);
    this.name = "PlanOverlayConflictError";
    this.date = date;
    this.expected = expected;
    this.actual = actual;
  }
}

export class PlanOverlayClosedError extends Error {
  readonly date: string;
  constructor(date: string) {
    super(`[plan-overlay:closed] date ${date} is closed`);
    this.name = "PlanOverlayClosedError";
    this.date = date;
  }
}

export class PlanOverlayCorruptError extends Error {
  readonly path: string;
  constructor(path: string, message: string, cause?: unknown) {
    super(`[plan-overlay:corrupt] ${path}: ${message}`, cause === undefined ? undefined : { cause });
    this.name = "PlanOverlayCorruptError";
    this.path = path;
  }
}

/* ───────────────────────── 基础校验 ───────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new PlanOverlayValidationError(field, `必须是对象: ${describe(value)}`);
  return value;
}

function assertKnownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const known = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw new PlanOverlayValidationError(`${field}.${key}`, "未知字段（schema v1 不接受扩展键）");
    }
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PlanOverlayValidationError(field, `必须是非空字符串: ${describe(value)}`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireNonEmptyString(value, field);
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new PlanOverlayValidationError(
      field,
      `必须是 ${allowed.join(" | ")} 之一: ${describe(value)}`,
    );
  }
  return value as T;
}

function requireInteger(value: unknown, field: string, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new PlanOverlayValidationError(field, `必须是 >=${String(min)} 的整数: ${describe(value)}`);
  }
  return value;
}

function requireId(value: unknown, field: string): string {
  const id = requireNonEmptyString(value, field);
  if (!ID_RE.test(id)) {
    throw new PlanOverlayValidationError(field, `必须匹配 ${ID_RE.source}: ${id}`);
  }
  return id;
}

function requireClockTime(value: unknown, field: string): string {
  if (typeof value !== "string" || !TIME_RE.test(value)) {
    throw new PlanOverlayValidationError(field, `必须是 HH:MM（00:00-23:59）: ${describe(value)}`);
  }
  return value;
}

function optionalClockTime(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireClockTime(value, field);
}

function requireStamp(value: unknown, field: string): string {
  const stamp = requireNonEmptyString(value, field);
  if (!STAMP_RE.test(stamp) || Number.isNaN(Date.parse(stamp))) {
    throw new PlanOverlayValidationError(field, `必须是日期或 ISO-8601 时间戳: ${stamp}`);
  }
  return stamp;
}

function optionalStamp(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireStamp(value, field);
}

function optionalAction(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const action = requireNonEmptyString(value, field);
  if (!isWakeAction(action)) {
    throw new PlanOverlayValidationError(field, `未知唤醒动作: ${action}`);
  }
  return action;
}

function requireStringArray(
  value: unknown,
  field: string,
  options: { readonly allowEmpty: boolean; readonly unique: boolean },
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new PlanOverlayValidationError(field, `必须是字符串数组: ${describe(value)}`);
  }
  if (!options.allowEmpty && value.length === 0) {
    throw new PlanOverlayValidationError(field, "至少需要一个元素");
  }
  const rows: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const row = requireNonEmptyString(value[index], `${field}[${String(index)}]`);
    if (options.unique && seen.has(row)) {
      throw new PlanOverlayValidationError(field, `重复元素: ${row}`);
    }
    seen.add(row);
    rows.push(row);
  }
  return rows;
}

export function requireOverlayDate(value: unknown, field = "date"): string {
  if (typeof value !== "string") {
    throw new PlanOverlayValidationError(field, `必须是 YYYY-MM-DD 字符串: ${describe(value)}`);
  }
  const match = DATE_RE.exec(value);
  if (match === null) throw new PlanOverlayValidationError(field, `必须是 YYYY-MM-DD: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const stamp = new Date(Date.UTC(year, month - 1, day));
  if (
    stamp.getUTCFullYear() !== year ||
    stamp.getUTCMonth() !== month - 1 ||
    stamp.getUTCDate() !== day
  ) {
    throw new PlanOverlayValidationError(field, `不是有效日期: ${value}`);
  }
  return value;
}

function requireCoverage(value: unknown, field = "coverage"): PlanCoverage {
  const record = requireRecord(value, field);
  assertKnownKeys(record, COVERAGE_KEYS, field);
  const profile = requireEnum(record["profile"], COVERAGE_PROFILES, `${field}.profile`);
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

function requireOverlayItem(value: unknown, field: string): PlanOverlayItem {
  const record = requireRecord(value, field);
  assertKnownKeys(record, ITEM_KEYS, field);
  const id = requireId(record["id"], `${field}.id`);
  const kind = requireEnum(record["kind"], PLAN_ITEM_KINDS, `${field}.kind`);
  const intent = requireNonEmptyString(record["intent"], `${field}.intent`);
  const status = requireEnum(record["status"], PLAN_ITEM_STATUSES, `${field}.status`);
  const at = optionalClockTime(record["at"], `${field}.at`);
  const action = optionalAction(record["action"], `${field}.action`);
  const window = optionalNonEmptyString(record["window"], `${field}.window`);
  const doneWhen = optionalNonEmptyString(record["done_when"], `${field}.done_when`);
  const note = optionalNonEmptyString(record["note"], `${field}.note`);
  const evidence = optionalNonEmptyString(record["evidence"], `${field}.evidence`);
  const doneAt = optionalStamp(record["done_at"], `${field}.done_at`);
  const targetDate =
    record["target_date"] === undefined
      ? undefined
      : requireOverlayDate(record["target_date"], `${field}.target_date`);
  const checkpointId =
    record["checkpoint_id"] === undefined
      ? undefined
      : requireId(record["checkpoint_id"], `${field}.checkpoint_id`);
  const notDo =
    record["not_do"] === undefined
      ? undefined
      : requireStringArray(record["not_do"], `${field}.not_do`, {
          allowEmpty: true,
          unique: true,
        });
  return {
    id,
    kind,
    intent,
    status,
    ...(at === undefined ? {} : { at }),
    ...(action === undefined ? {} : { action }),
    ...("payload" in record ? { payload: record["payload"] } : {}),
    ...(window === undefined ? {} : { window }),
    ...(doneWhen === undefined ? {} : { done_when: doneWhen }),
    ...(note === undefined ? {} : { note }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(doneAt === undefined ? {} : { done_at: doneAt }),
    ...(targetDate === undefined ? {} : { target_date: targetDate }),
    ...(checkpointId === undefined ? {} : { checkpoint_id: checkpointId }),
    ...(notDo === undefined ? {} : { not_do: notDo }),
  };
}

function requireOverlayPatch(value: unknown, field: string): PlanOverlayPatch {
  const record = requireRecord(value, field);
  assertKnownKeys(record, PATCH_KEYS, field);
  const keys = Object.keys(record);
  if (keys.length === 0) {
    throw new PlanOverlayValidationError(field, "至少需要一个修改字段");
  }
  const patch: Record<string, unknown> = {};
  for (const key of keys) {
    const raw = record[key];
    if (raw === null) {
      if (key === "status") {
        throw new PlanOverlayValidationError(`${field}.${key}`, "status 不可置空");
      }
      patch[key] = null;
      continue;
    }
    switch (key) {
      case "at":
        patch[key] = requireClockTime(raw, `${field}.${key}`);
        break;
      case "action": {
        if (!isWakeAction(raw)) {
          throw new PlanOverlayValidationError(`${field}.${key}`, `未知唤醒动作: ${describe(raw)}`);
        }
        patch[key] = raw;
        break;
      }
      case "payload":
        patch[key] = raw;
        break;
      case "status":
        patch[key] = requireEnum(raw, PLAN_ITEM_STATUSES, `${field}.${key}`);
        break;
      case "done_at":
        patch[key] = requireStamp(raw, `${field}.${key}`);
        break;
      default:
        patch[key] = requireNonEmptyString(raw, `${field}.${key}`);
    }
  }
  return patch as PlanOverlayPatch;
}

function requireOverlayOp(value: unknown, field: string): PlanOverlayOp {
  const record = requireRecord(value, field);
  const op = requireNonEmptyString(record["op"], `${field}.op`);
  switch (op) {
    case "add":
      assertKnownKeys(record, ["op", "item"], field);
      return { op, item: requireOverlayItem(record["item"], `${field}.item`) };
    case "update":
      assertKnownKeys(record, ["op", "id", "patch"], field);
      return {
        op,
        id: requireId(record["id"], `${field}.id`),
        patch: requireOverlayPatch(record["patch"], `${field}.patch`),
      };
    case "remove":
      assertKnownKeys(record, ["op", "id"], field);
      return { op, id: requireId(record["id"], `${field}.id`) };
    case "note":
      assertKnownKeys(record, ["op", "text"], field);
      return { op, text: requireNonEmptyString(record["text"], `${field}.text`) };
    default:
      throw new PlanOverlayValidationError(
        `${field}.op`,
        `未知操作 ${describe(op)}，允许 add | update | remove | note`,
      );
  }
}

function opTargetId(op: PlanOverlayOp): string | null {
  switch (op.op) {
    case "add":
      return op.item.id;
    case "update":
    case "remove":
      return op.id;
    case "note":
      return null;
  }
}

function requireOps(value: unknown): readonly PlanOverlayOp[] {
  if (!Array.isArray(value)) {
    throw new PlanOverlayValidationError("ops", `必须是数组: ${describe(value)}`);
  }
  const ops = value.map((entry, index) =>
    requireOverlayOp(entry, `ops[${String(index)}]`),
  );
  const seen = new Set<string>();
  for (const op of ops) {
    const id = opTargetId(op);
    if (id === null) continue;
    if (seen.has(id)) {
      throw new PlanOverlayValidationError("ops.id", `重复操作 id: ${id}`);
    }
    seen.add(id);
  }
  return ops;
}

export function validatePlanOverlayDocument(value: unknown): PlanOverlayDocument {
  const record = requireRecord(value, "overlay");
  assertKnownKeys(record, DOCUMENT_KEYS, "overlay");
  if (record["schema"] !== OVERLAY_SCHEMA) {
    throw new PlanOverlayValidationError(
      "schema",
      `只支持 ${String(OVERLAY_SCHEMA)}: ${describe(record["schema"])}`,
    );
  }
  if (record["kind"] !== "plan-overlay") {
    throw new PlanOverlayValidationError("kind", `必须是 "plan-overlay": ${describe(record["kind"])}`);
  }
  const date = requireOverlayDate(record["date"]);
  const baseVersion = requireInteger(record["base_version"], "base_version", 1);
  const version = requireInteger(record["version"], "version", 1);
  const status = requireEnum(record["status"], OVERLAY_STATUSES, "status");
  const createdAt = requireInteger(record["created_at"], "created_at", 0);
  const updatedAt = requireInteger(record["updated_at"], "updated_at", 0);
  if (updatedAt < createdAt) {
    throw new PlanOverlayValidationError("updated_at", "不得早于 created_at");
  }
  const ops = requireOps(record["ops"]);
  const notes = requireStringArray(record["notes"], "notes", {
    allowEmpty: true,
    unique: false,
  });
  const coverage = requireCoverage(record["coverage"]);
  const userIntent = optionalNonEmptyString(record["user_intent"], "user_intent");
  return {
    schema: OVERLAY_SCHEMA,
    kind: "plan-overlay",
    date,
    base_version: baseVersion,
    version,
    status,
    created_at: createdAt,
    updated_at: updatedAt,
    ops,
    notes,
    coverage,
    ...(userIntent === undefined ? {} : { user_intent: userIntent }),
  };
}

export function validatePlanOverlayWriteInput(value: unknown): PlanOverlayDraft {
  const record = requireRecord(value, "overlay");
  assertKnownKeys(
    record,
    ["date", "base_version", "ops", "coverage", "notes", "user_intent"],
    "overlay",
  );
  const date = requireOverlayDate(record["date"]);
  const baseVersion = requireInteger(record["base_version"], "base_version", 1);
  const ops = requireOps(record["ops"]);
  const coverage = requireCoverage(record["coverage"]);
  const notes =
    record["notes"] === undefined
      ? []
      : requireStringArray(record["notes"], "notes", { allowEmpty: true, unique: false });
  const userIntent = optionalNonEmptyString(record["user_intent"], "user_intent");
  return {
    date,
    base_version: baseVersion,
    ops,
    coverage,
    notes,
    ...(userIntent === undefined ? {} : { user_intent: userIntent }),
  };
}

export function validatePlanOverlayReviseInput(value: unknown): PlanOverlayReviseInput {
  const record = requireRecord(value, "revise");
  assertKnownKeys(
    record,
    ["base_version", "ops", "coverage", "notes_append", "user_intent"],
    "revise",
  );
  if (Object.keys(record).length === 0) {
    throw new PlanOverlayValidationError("revise", "至少需要一个修改字段");
  }
  const userIntent = optionalNonEmptyString(record["user_intent"], "revise.user_intent");
  return {
    ...(record["base_version"] === undefined
      ? {}
      : { base_version: requireInteger(record["base_version"], "revise.base_version", 1) }),
    ...(record["ops"] === undefined ? {} : { ops: requireOps(record["ops"]) }),
    ...(record["coverage"] === undefined
      ? {}
      : { coverage: requireCoverage(record["coverage"], "revise.coverage") }),
    ...(record["notes_append"] === undefined
      ? {}
      : {
          notes_append: requireStringArray(record["notes_append"], "revise.notes_append", {
            allowEmpty: true,
            unique: false,
          }),
        }),
    ...(userIntent === undefined ? {} : { user_intent: userIntent }),
  };
}

/* ───────────────────────── 与母版对账 ───────────────────────── */

/** commit 前调用：base_version 必须等于当前母版版本。 */
export function assertOverlayBaseFresh(
  overlay: PlanOverlayDocument,
  master: MasterPlanDocument,
): void {
  if (overlay.base_version !== master.version) {
    throw new OverlayBaseStaleError(overlay.date, overlay.base_version, master.version);
  }
}

/**
 * 显式对账：update/remove 必须命中当日母版条目，add 不得与母版 id 冲突。
 * mergeOverlay 在母版漂移时只告警，不做这层严格拒绝。
 */
export function validatePlanOverlayAgainstMaster(
  master: MasterPlanDocument,
  overlay: PlanOverlayDocument,
  dateKey: string,
): void {
  const day = requireOverlayDate(dateKey, "dateKey");
  if (overlay.date !== day) {
    throw new PlanOverlayValidationError(
      "date",
      `覆盖层日期 ${overlay.date} 与请求日期 ${day} 不一致`,
    );
  }
  const masterIds = new Set(materializeMasterEntries(master, day).map((entry) => entry.id));
  for (let index = 0; index < overlay.ops.length; index += 1) {
    const op = overlay.ops[index];
    if (op === undefined || op.op === "note") continue;
    const field = `ops[${String(index)}]`;
    if (op.op === "add") {
      if (masterIds.has(op.item.id)) {
        throw new PlanOverlayValidationError(`${field}.item.id`, `与母版当日条目冲突: ${op.item.id}`);
      }
      continue;
    }
    if (!masterIds.has(op.id)) {
      throw new PlanOverlayValidationError(`${field}.id`, `母版当日不存在该条目: ${op.id}`);
    }
  }
}

/* ───────────────────────── care 条目可核验校验 ───────────────────────── */

const CARE_CLOCK_RE = /(?<!\d)(?:[01]?\d|2[0-3])[:：][0-5]\d(?!\d)/;
const CARE_DONE_WHEN_RULE =
  "care 条目的 done_when 必须可核验：提供非空 window，或在 done_when 里写出 HH:MM 时间；否则请改用 kind=note";

export interface ValidateCareEntriesOptions {
  readonly priorOps?: readonly PlanOverlayOp[];
}

interface CareTarget {
  readonly kind: MasterKind | PlanItemKind;
  readonly done_when: string | undefined;
  readonly window: string | undefined;
}

function isNonEmptyText(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

function hasVerifiableCareShape(
  doneWhen: string | undefined,
  window: string | undefined,
): boolean {
  return isNonEmptyText(doneWhen) && (isNonEmptyText(window) || CARE_CLOCK_RE.test(doneWhen));
}

function assertCareEntry(
  field: string,
  doneWhen: string | undefined,
  window: string | undefined,
): void {
  if (!hasVerifiableCareShape(doneWhen, window)) {
    throw new PlanOverlayValidationError(field, CARE_DONE_WHEN_RULE);
  }
}

function isGrandfatheredCareAdd(
  item: PlanOverlayItem,
  priorOps: readonly PlanOverlayOp[] | undefined,
): boolean {
  if (priorOps === undefined) return false;
  return priorOps.some(
    (prior) =>
      prior.op === "add" &&
      prior.item.id === item.id &&
      prior.item.done_when === item.done_when &&
      prior.item.window === item.window,
  );
}

function resolveCareTargets(
  master: MasterPlanDocument,
  overlay: PlanOverlayDocument,
  priorOps: readonly PlanOverlayOp[] | undefined,
  dateKey: string,
): ReadonlyMap<string, CareTarget> {
  const targets = new Map<string, CareTarget>();
  for (const entry of materializeMasterEntries(master, dateKey)) {
    targets.set(entry.id, {
      kind: entry.kind,
      done_when: entry.done_when,
      window: entry.window,
    });
  }
  for (const prior of priorOps ?? []) {
    if (prior.op !== "add") continue;
    targets.set(prior.item.id, {
      kind: prior.item.kind,
      done_when: prior.item.done_when,
      window: prior.item.window,
    });
  }
  for (const op of overlay.ops) {
    if (op.op !== "add") continue;
    targets.set(op.item.id, {
      kind: op.item.kind,
      done_when: op.item.done_when,
      window: op.item.window,
    });
  }
  return targets;
}

/**
 * 纯校验：care 条目的完成条件必须机器可核验（非空 window 或 done_when 内 HH:MM）。
 * priorOps 用于兼容既有覆盖层里未按新规则书写的 add；字段未变则放行。
 */
export function validateCareEntries(
  master: MasterPlanDocument,
  overlay: PlanOverlayDocument,
  dateKey: string,
  options?: ValidateCareEntriesOptions,
): void {
  const priorOps = options?.priorOps;
  const targets = resolveCareTargets(master, overlay, priorOps, dateKey);
  for (let index = 0; index < overlay.ops.length; index += 1) {
    const op = overlay.ops[index];
    if (op === undefined) continue;
    const field = `ops[${String(index)}]`;
    if (op.op === "add") {
      if (op.item.kind !== "care") continue;
      if (isGrandfatheredCareAdd(op.item, priorOps)) continue;
      assertCareEntry(`${field}.item.done_when`, op.item.done_when, op.item.window);
      continue;
    }
    if (op.op !== "update") continue;
    if (!hasPatchKey(op.patch, "done_when") && !hasPatchKey(op.patch, "window")) continue;
    const target = targets.get(op.id);
    if (target === undefined || target.kind !== "care") continue;
    const doneWhen = hasPatchKey(op.patch, "done_when")
      ? (op.patch.done_when ?? undefined)
      : target.done_when;
    const window = hasPatchKey(op.patch, "window")
      ? (op.patch.window ?? undefined)
      : target.window;
    assertCareEntry(`${field}.patch.done_when`, doneWhen, window);
  }
}

/* ───────────────────────── 有效视图合并 ───────────────────────── */

function fromMasterEntry(
  entry: MasterEntry,
  masterVersion: number,
  overlayVersion: number,
): EffectivePlanEntry {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    ...(entry.intent === undefined ? {} : { intent: entry.intent }),
    at: entry.schedule.at,
    at_override: false,
    ...(entry.action === undefined ? {} : { action: entry.action }),
    ...(entry.payload === undefined ? {} : { payload: entry.payload }),
    ...(entry.instruction === undefined ? {} : { instruction: entry.instruction }),
    ...(entry.window === undefined ? {} : { window: entry.window }),
    ...(entry.done_when === undefined ? {} : { done_when: entry.done_when }),
    ...(entry.target_date === undefined ? {} : { target_date: entry.target_date }),
    status: "planned",
    source: "master",
    suppressed: false,
    master_version: masterVersion,
    overlay_version: overlayVersion,
  };
}

function fromOverlayItem(
  item: PlanOverlayItem,
  masterVersion: number,
  overlayVersion: number,
): EffectivePlanEntry {
  return {
    id: item.id,
    kind: item.kind,
    intent: item.intent,
    ...(item.at === undefined ? {} : { at: item.at }),
    at_override: false,
    ...(item.action === undefined ? {} : { action: item.action }),
    ...(item.payload === undefined ? {} : { payload: item.payload }),
    ...(item.window === undefined ? {} : { window: item.window }),
    ...(item.done_when === undefined ? {} : { done_when: item.done_when }),
    ...(item.target_date === undefined ? {} : { target_date: item.target_date }),
    ...(item.checkpoint_id === undefined ? {} : { checkpoint_id: item.checkpoint_id }),
    ...(item.not_do === undefined ? {} : { not_do: item.not_do }),
    ...(item.note === undefined ? {} : { note: item.note }),
    status: item.status,
    ...(item.evidence === undefined ? {} : { evidence: item.evidence }),
    ...(item.done_at === undefined ? {} : { done_at: item.done_at }),
    source: "overlay",
    suppressed: false,
    master_version: masterVersion,
    overlay_version: overlayVersion,
  };
}

function hasPatchKey(patch: PlanOverlayPatch, key: keyof PlanOverlayPatch): boolean {
  return Object.prototype.hasOwnProperty.call(patch, key);
}

function patchValue<T>(
  patch: PlanOverlayPatch,
  key: keyof PlanOverlayPatch,
  current: T | undefined,
): T | undefined {
  if (!hasPatchKey(patch, key)) return current;
  const raw = patch[key];
  return raw === null ? undefined : (raw as T | undefined);
}

function applyPatch(target: EffectivePlanEntry, patch: PlanOverlayPatch): EffectivePlanEntry {
  const at = patchValue<string>(patch, "at", target.at);
  const action = patchValue<string>(patch, "action", target.action);
  const payload = patchValue<unknown>(patch, "payload", target.payload);
  const intent = patchValue<string>(patch, "intent", target.intent);
  const window = patchValue<string>(patch, "window", target.window);
  const doneWhen = patchValue<string>(patch, "done_when", target.done_when);
  const note = patchValue<string>(patch, "note", target.note);
  const evidence = patchValue<string>(patch, "evidence", target.evidence);
  const doneAt = patchValue<string>(patch, "done_at", target.done_at);
  return {
    id: target.id,
    kind: target.kind,
    ...(target.title === undefined ? {} : { title: target.title }),
    ...(intent === undefined ? {} : { intent }),
    ...(at === undefined ? {} : { at }),
    at_override: hasPatchKey(patch, "at") && at !== undefined,
    ...(action === undefined ? {} : { action }),
    ...(payload === undefined ? {} : { payload }),
    ...(target.instruction === undefined ? {} : { instruction: target.instruction }),
    ...(window === undefined ? {} : { window }),
    ...(doneWhen === undefined ? {} : { done_when: doneWhen }),
    ...(target.target_date === undefined ? {} : { target_date: target.target_date }),
    ...(target.checkpoint_id === undefined ? {} : { checkpoint_id: target.checkpoint_id }),
    ...(target.not_do === undefined ? {} : { not_do: target.not_do }),
    ...(note === undefined ? {} : { note }),
    status: hasPatchKey(patch, "status") ? (patch.status as PlanItemStatus) : target.status,
    ...(evidence === undefined ? {} : { evidence }),
    ...(doneAt === undefined ? {} : { done_at: doneAt }),
    source: target.source,
    suppressed: target.suppressed,
    master_version: target.master_version,
    overlay_version: target.overlay_version,
  };
}

/** 纯函数：母版保持原样，返回按当日物化后应用覆盖层的有效视图。 */
export function mergeOverlay(
  master: MasterPlanDocument,
  overlay: PlanOverlayDocument,
  dateKey: string,
): EffectivePlan {
  const day = requireOverlayDate(dateKey, "dateKey");
  if (overlay.date !== day) {
    throw new PlanOverlayValidationError(
      "date",
      `覆盖层日期 ${overlay.date} 与请求日期 ${day} 不一致`,
    );
  }
  const warnings: string[] = [];
  if (overlay.base_version === master.version) {
    // 基线一致时未知 id / add 撞 id 是覆盖层自身错误，直接拒绝；
    // 只有母版漂移（base_version 落后）才降级为告警并跳过孤儿 op。
    validatePlanOverlayAgainstMaster(master, overlay, day);
  } else {
    warnings.push(`base_stale:${String(overlay.base_version)}!=${String(master.version)}`);
  }
  const entries = materializeMasterEntries(master, day).map((entry) =>
    fromMasterEntry(entry, master.version, overlay.version),
  );
  const index = new Map(entries.map((entry) => [entry.id, entry]));
  const notes = [...overlay.notes];

  for (const op of overlay.ops) {
    switch (op.op) {
      case "add": {
        if (index.has(op.item.id)) {
          warnings.push(`add_collision:${op.item.id}`);
          break;
        }
        const entry = fromOverlayItem(op.item, master.version, overlay.version);
        entries.push(entry);
        index.set(entry.id, entry);
        break;
      }
      case "update": {
        const target = index.get(op.id);
        if (target === undefined) {
          warnings.push(`orphan_update:${op.id}`);
          break;
        }
        const updated = applyPatch(target, op.patch);
        const at = entries.findIndex((entry) => entry.id === op.id);
        if (at !== -1) entries[at] = updated;
        index.set(op.id, updated);
        break;
      }
      case "remove": {
        const target = index.get(op.id);
        if (target === undefined) {
          warnings.push(`orphan_remove:${op.id}`);
          break;
        }
        const suppressed = { ...target, suppressed: true };
        const at = entries.findIndex((entry) => entry.id === op.id);
        if (at !== -1) entries[at] = suppressed;
        index.set(op.id, suppressed);
        break;
      }
      case "note":
        notes.push(op.text);
        break;
    }
  }

  return {
    date: day,
    origin: "overlay",
    status: overlay.status,
    base_version: overlay.base_version,
    master_version: master.version,
    overlay_version: overlay.version,
    coverage: overlay.coverage,
    entries,
    notes,
    warnings,
    ...(overlay.user_intent === undefined ? {} : { user_intent: overlay.user_intent }),
  };
}

/** 无覆盖层时的 v1 只读回退：把旧日计划整体映射成有效视图，不回写任何文件。 */
export function effectiveFromLegacyPlan(
  legacy: {
    readonly date: string;
    readonly status: PlanOverlayStatus;
    readonly version: number;
    readonly coverage: PlanCoverage;
    readonly notes: readonly string[];
    readonly items: readonly {
      readonly id: string;
      readonly kind: PlanItemKind;
      readonly intent: string;
      readonly status: PlanItemStatus;
      readonly target_date?: string;
      readonly window?: string;
      readonly checkpoint_id?: string;
      readonly done_when?: string;
      readonly not_do?: readonly string[];
      readonly note?: string;
    }[];
  },
  master: MasterPlanDocument,
): EffectivePlan {
  const entries = legacy.items.map((item) => ({
    id: item.id,
    kind: item.kind,
    intent: item.intent,
    ...(item.target_date === undefined ? {} : { target_date: item.target_date }),
    ...(item.window === undefined ? {} : { window: item.window }),
    ...(item.checkpoint_id === undefined ? {} : { checkpoint_id: item.checkpoint_id }),
    ...(item.done_when === undefined ? {} : { done_when: item.done_when }),
    ...(item.not_do === undefined ? {} : { not_do: item.not_do }),
    ...(item.note === undefined ? {} : { note: item.note }),
    status: item.status,
    at_override: false,
    source: "overlay" as const,
    suppressed: false,
    master_version: master.version,
    overlay_version: legacy.version,
  }));
  return {
    date: legacy.date,
    origin: "legacy",
    status: legacy.status,
    base_version: master.version,
    master_version: master.version,
    overlay_version: legacy.version,
    coverage: legacy.coverage,
    entries,
    notes: legacy.notes,
    warnings: ["legacy_fallback"],
  };
}

/* ───────────────────────── Markdown 渲染 ───────────────────────── */

function bullet(label: string, value: string): string {
  return `- ${label}: ${value}`;
}

export function renderEffectiveMarkdown(plan: EffectivePlan): string {
  const lines: string[] = [`# ${plan.date} 计划（母版 + 当日 diff）`, ""];
  lines.push(bullet("来源", plan.origin));
  lines.push(bullet("状态", plan.status));
  if (plan.user_intent !== undefined) lines.push(bullet("用户意图", plan.user_intent));
  lines.push(bullet("母版版本", String(plan.master_version)));
  lines.push(bullet("覆盖层版本", String(plan.overlay_version)));
  lines.push(bullet("母版基线", String(plan.base_version)));
  lines.push(bullet("覆盖档", plan.coverage.profile));
  lines.push(
    bullet(
      "覆盖检查点",
      plan.coverage.checkpoints.length === 0 ? "无" : plan.coverage.checkpoints.join(", "),
    ),
  );
  lines.push(
    bullet("覆盖债", plan.coverage.debt.length === 0 ? "无" : plan.coverage.debt.join(", ")),
  );
  lines.push("", "## 条目", "");
  if (plan.entries.length === 0) lines.push("（空计划）", "");
  for (const entry of plan.entries) {
    const title = entry.title === undefined ? "" : ` ${entry.title}`;
    lines.push(`### ${entry.id} [${entry.kind}]${title}`, "");
    lines.push(bullet("来源", entry.source));
    lines.push(bullet("状态", entry.status));
    if (entry.suppressed) lines.push(bullet("抑制", "true（母版条目已被当日移除）"));
    if (entry.at !== undefined) {
      lines.push(bullet(entry.at_override ? "时间（覆盖）" : "时间", entry.at));
    }
    if (entry.intent !== undefined) lines.push(bullet("意图", entry.intent));
    if (entry.action !== undefined) lines.push(bullet("动作", entry.action));
    if (entry.window !== undefined) lines.push(bullet("窗口", entry.window));
    if (entry.done_when !== undefined) lines.push(bullet("完成条件", entry.done_when));
    if (entry.note !== undefined) lines.push(bullet("备注", entry.note));
    if (entry.evidence !== undefined) lines.push(bullet("证据", entry.evidence));
    if (entry.done_at !== undefined) lines.push(bullet("完成时间", entry.done_at));
    if (entry.instruction !== undefined) lines.push(bullet("指令", entry.instruction));
    lines.push("");
  }
  lines.push("## 笔记", "");
  if (plan.notes.length === 0) {
    lines.push("（无）");
  } else {
    for (const note of plan.notes) lines.push(`- ${note}`);
  }
  if (plan.warnings.length > 0) {
    lines.push("", "## 警告", "");
    for (const warning of plan.warnings) lines.push(`- ${warning}`);
  }
  return `${lines.join("\n")}\n`;
}
