/**
 * Master Plan 的 v1 schema、纯校验、到期物化与显式编辑 op。
 *
 * Master Plan 是「先于模型」的固定排班真源：包含固定时段槽位（fixed）、
 * 覆盖锚点（anchor）和长期条目（long_term）。日计划是它的差量覆盖层，
 * 绝不回写本文件。本层不碰磁盘，磁盘实现见 json-master-plan-store.ts。
 */

import { isWakeAction } from "./actions.js";
import type { WakeSchedule } from "./timezone.js";

export const MASTER_SCHEMA = 1 as const;
export const MASTER_KINDS = ["fixed", "anchor", "long_term"] as const;
export const MASTER_STATUSES = ["active", "paused", "archived"] as const;
export const MASTER_TARGET_DATES = ["today", "previous_day"] as const;

export type MasterKind = (typeof MASTER_KINDS)[number];
export type MasterStatus = (typeof MASTER_STATUSES)[number];
export type MasterTargetDate = (typeof MASTER_TARGET_DATES)[number];

export type MasterSchedule = WakeSchedule;

export interface MasterEntry {
  readonly id: string;
  readonly kind: MasterKind;
  readonly title: string;
  readonly intent?: string;
  readonly enabled: boolean;
  readonly action?: string;
  readonly payload?: unknown;
  readonly instruction?: string;
  readonly schedule: MasterSchedule;
  readonly target_date?: MasterTargetDate;
  readonly window?: string;
  readonly done_when?: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly last_done?: string;
  readonly status?: MasterStatus;
  readonly next_check?: string;
  readonly legacy_long_task_id?: string;
}

export interface MasterPlanDocument {
  readonly schema: typeof MASTER_SCHEMA;
  readonly kind: "master-plan";
  readonly timezone: string;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly entries: readonly MasterEntry[];
}

export type MasterEditOp =
  | { readonly op: "upsert_entry"; readonly entry: MasterEntry }
  | { readonly op: "replace_entry"; readonly entry: MasterEntry }
  | { readonly op: "remove_entry"; readonly id: string }
  | { readonly op: "set_enabled"; readonly id: string; readonly enabled: boolean }
  | { readonly op: "set_status"; readonly id: string; readonly status: MasterStatus }
  | {
      readonly op: "update_entry";
      readonly id: string;
      readonly patch: MasterEntryPatch;
    };

/** update_entry 只接受内容字段；id/kind/时间戳不可隐式改写。 */
export interface MasterEntryPatch {
  readonly title?: string;
  readonly intent?: string | null;
  readonly enabled?: boolean;
  readonly action?: string | null;
  readonly payload?: unknown;
  readonly instruction?: string | null;
  readonly schedule?: MasterSchedule;
  readonly target_date?: MasterTargetDate | null;
  readonly window?: string | null;
  readonly done_when?: string | null;
  readonly last_done?: string | null;
  readonly status?: MasterStatus | null;
  readonly next_check?: string | null;
  readonly legacy_long_task_id?: string | null;
}

export class MasterPlanValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`[master-plan:validation] ${field}: ${message}`);
    this.name = "MasterPlanValidationError";
    this.field = field;
  }
}

export class MasterPlanNotFoundError extends Error {
  constructor(message = "master plan not found") {
    super(`[master-plan:not-found] ${message}`);
    this.name = "MasterPlanNotFoundError";
  }
}

export class MasterPlanConflictError extends Error {
  readonly expected: number | null;
  readonly actual: number;
  constructor(expected: number | null, actual: number) {
    super(`[master-plan:conflict] expected ${String(expected)}, actual ${String(actual)}`);
    this.name = "MasterPlanConflictError";
    this.expected = expected;
    this.actual = actual;
  }
}

export class MasterPlanCorruptError extends Error {
  readonly path: string;
  constructor(path: string, message: string, cause?: unknown) {
    super(`[master-plan:corrupt] ${path}: ${message}`, cause === undefined ? undefined : { cause });
    this.name = "MasterPlanCorruptError";
    this.path = path;
  }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const WINDOW_RE = /^([01]\d|2[0-3]):[0-5]\d~([01]\d|2[0-3]):[0-5]\d$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WEEKDAY_NAMES = new Set([
  "sun",
  "sunday",
  "mon",
  "monday",
  "tue",
  "tues",
  "tuesday",
  "wed",
  "wednesday",
  "thu",
  "thur",
  "thurs",
  "thursday",
  "fri",
  "friday",
  "sat",
  "saturday",
]);

const DOCUMENT_KEYS = ["schema", "kind", "timezone", "version", "created_at", "updated_at", "entries"] as const;
const ENTRY_KEYS = [
  "id",
  "kind",
  "title",
  "intent",
  "enabled",
  "action",
  "payload",
  "instruction",
  "schedule",
  "target_date",
  "window",
  "done_when",
  "created_at",
  "updated_at",
  "last_done",
  "status",
  "next_check",
  "legacy_long_task_id",
] as const;
const PATCH_KEYS = [
  "title",
  "intent",
  "enabled",
  "action",
  "payload",
  "instruction",
  "schedule",
  "target_date",
  "window",
  "done_when",
  "last_done",
  "status",
  "next_check",
  "legacy_long_task_id",
] as const;

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
  if (!isRecord(value)) throw new MasterPlanValidationError(field, `必须是对象: ${describe(value)}`);
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
      throw new MasterPlanValidationError(`${field}.${key}`, "未知字段（schema v1 不接受扩展键）");
    }
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MasterPlanValidationError(field, `必须是非空字符串: ${describe(value)}`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, field);
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new MasterPlanValidationError(field, `必须是 ${allowed.join(" | ")} 之一: ${describe(value)}`);
  }
  return value as T;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new MasterPlanValidationError(field, `必须是布尔值: ${describe(value)}`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new MasterPlanValidationError(field, `必须是非负整数毫秒时间戳: ${describe(value)}`);
  }
  return value;
}

function requireVersion(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new MasterPlanValidationError(field, `必须是 >=1 的整数: ${describe(value)}`);
  }
  return value;
}

/** 严格 YYYY-MM-DD，拒绝 2026-02-30 这类日历越界值。 */
export function requireMasterDate(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new MasterPlanValidationError(field, `必须是 YYYY-MM-DD 字符串: ${describe(value)}`);
  }
  const match = DATE_RE.exec(value);
  if (match === null) throw new MasterPlanValidationError(field, `必须是 YYYY-MM-DD: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const stamp = new Date(Date.UTC(year, month - 1, day));
  if (
    stamp.getUTCFullYear() !== year ||
    stamp.getUTCMonth() !== month - 1 ||
    stamp.getUTCDate() !== day
  ) {
    throw new MasterPlanValidationError(field, `不是有效日期: ${value}`);
  }
  return value;
}

export function requireMasterTime(value: unknown, field: string): string {
  if (typeof value !== "string" || !TIME_RE.test(value)) {
    throw new MasterPlanValidationError(field, `必须是 HH:MM（00:00-23:59）: ${describe(value)}`);
  }
  return value;
}

function requireTimezone(value: unknown, field: string): string {
  const zone = requireNonEmptyString(value, field);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new MasterPlanValidationError(field, `不是有效 IANA 时区: ${zone}`);
  }
  return zone;
}

function requireStringId(value: unknown, field: string): string {
  const id = requireNonEmptyString(value, field);
  if (!ID_RE.test(id)) {
    throw new MasterPlanValidationError(field, `必须匹配 ${ID_RE.source}: ${id}`);
  }
  return id;
}

function parseWeekday(value: unknown, field: string): string | number {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > 7) {
      throw new MasterPlanValidationError(field, `周几必须是 0-7: ${describe(value)}`);
    }
    return value;
  }
  if (typeof value === "string") {
    const token = value.trim().toLowerCase();
    if (WEEKDAY_NAMES.has(token)) return token;
    if (/^[0-7]$/.test(token)) return Number(token);
  }
  throw new MasterPlanValidationError(field, `非法周几: ${describe(value)}`);
}

function parseMonthDay(value: unknown, field: string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 31) {
    throw new MasterPlanValidationError(field, `每月日期必须是 1-31: ${describe(value)}`);
  }
  return numeric;
}

export function validateMasterSchedule(value: unknown, field = "schedule"): MasterSchedule {
  const record = requireRecord(value, field);
  const kind = requireNonEmptyString(record["kind"], `${field}.kind`);
  switch (kind) {
    case "daily": {
      assertKnownKeys(record, ["kind", "at"], field);
      return { kind: "daily", at: requireMasterTime(record["at"], `${field}.at`) };
    }
    case "weekly": {
      assertKnownKeys(record, ["kind", "days", "at"], field);
      const rawDays = record["days"];
      if (!Array.isArray(rawDays) || rawDays.length === 0) {
        throw new MasterPlanValidationError(`${field}.days`, "至少需要一个周几");
      }
      const days = rawDays.map((day, index) => parseWeekday(day, `${field}.days[${String(index)}]`));
      if (new Set(days.map(String)).size !== days.length) {
        throw new MasterPlanValidationError(`${field}.days`, "周几不得重复");
      }
      return { kind: "weekly", days, at: requireMasterTime(record["at"], `${field}.at`) };
    }
    case "monthly": {
      assertKnownKeys(record, ["kind", "days", "at"], field);
      const rawDays = record["days"];
      if (!Array.isArray(rawDays) || rawDays.length === 0) {
        throw new MasterPlanValidationError(`${field}.days`, "至少需要一个每月日期");
      }
      const days = rawDays.map((day, index) => parseMonthDay(day, `${field}.days[${String(index)}]`));
      if (new Set(days).size !== days.length) {
        throw new MasterPlanValidationError(`${field}.days`, "每月日期不得重复");
      }
      return { kind: "monthly", days, at: requireMasterTime(record["at"], `${field}.at`) };
    }
    case "once": {
      assertKnownKeys(record, ["kind", "date", "at"], field);
      return {
        kind: "once",
        date: requireMasterDate(record["date"], `${field}.date`),
        at: requireMasterTime(record["at"], `${field}.at`),
      };
    }
    default:
      throw new MasterPlanValidationError(
        `${field}.kind`,
        `必须是 daily | weekly | monthly | once 之一: ${kind}`,
      );
  }
}

export function validateMasterEntry(value: unknown, field = "entry"): MasterEntry {
  const record = requireRecord(value, field);
  assertKnownKeys(record, ENTRY_KEYS, field);

  const id = requireStringId(record["id"], `${field}.id`);
  const kind = requireEnum(record["kind"], MASTER_KINDS, `${field}.kind`);
  const title = requireNonEmptyString(record["title"], `${field}.title`);
  const intent = optionalNonEmptyString(record["intent"], `${field}.intent`);
  const enabled = requireBoolean(record["enabled"], `${field}.enabled`);
  const action = optionalNonEmptyString(record["action"], `${field}.action`);
  if (action !== undefined && !isWakeAction(action)) {
    throw new MasterPlanValidationError(`${field}.action`, `未知唤醒动作: ${action}`);
  }
  const instruction = optionalNonEmptyString(record["instruction"], `${field}.instruction`);
  const schedule = validateMasterSchedule(record["schedule"], `${field}.schedule`);
  const targetDate =
    record["target_date"] === undefined
      ? undefined
      : requireEnum(record["target_date"], MASTER_TARGET_DATES, `${field}.target_date`);
  if (targetDate === "previous_day" && action !== "coverage.run") {
    throw new MasterPlanValidationError(
      `${field}.target_date`,
      "previous_day 只允许用于 coverage.run 条目",
    );
  }
  const window = optionalNonEmptyString(record["window"], `${field}.window`);
  if (window !== undefined && !WINDOW_RE.test(window)) {
    throw new MasterPlanValidationError(`${field}.window`, `必须是 HH:MM~HH:MM: ${window}`);
  }
  const doneWhen = optionalNonEmptyString(record["done_when"], `${field}.done_when`);
  const createdAt = requireTimestamp(record["created_at"], `${field}.created_at`);
  const updatedAt = requireTimestamp(record["updated_at"], `${field}.updated_at`);
  if (updatedAt < createdAt) {
    throw new MasterPlanValidationError(`${field}.updated_at`, "不得早于 created_at");
  }
  const lastDone =
    record["last_done"] === undefined
      ? undefined
      : requireMasterDate(record["last_done"], `${field}.last_done`);
  const status =
    record["status"] === undefined
      ? undefined
      : requireEnum(record["status"], MASTER_STATUSES, `${field}.status`);
  const nextCheck =
    record["next_check"] === undefined
      ? undefined
      : requireMasterDate(record["next_check"], `${field}.next_check`);
  const legacyId = optionalNonEmptyString(
    record["legacy_long_task_id"],
    `${field}.legacy_long_task_id`,
  );
  if (kind === "long_term" && status === undefined) {
    throw new MasterPlanValidationError(
      `${field}.status`,
      "long_term 条目必须显式给出 active | paused | archived",
    );
  }
  if (kind === "long_term" && status === "active" && nextCheck === undefined) {
    throw new MasterPlanValidationError(
      `${field}.next_check`,
      "active long_term 必须显式给出下一次检查日期",
    );
  }

  return {
    id,
    kind,
    title,
    ...(intent === undefined ? {} : { intent }),
    enabled,
    ...(action === undefined ? {} : { action }),
    ...(record["payload"] === undefined ? {} : { payload: record["payload"] }),
    ...(instruction === undefined ? {} : { instruction }),
    schedule,
    ...(targetDate === undefined ? {} : { target_date: targetDate }),
    ...(window === undefined ? {} : { window }),
    ...(doneWhen === undefined ? {} : { done_when: doneWhen }),
    created_at: createdAt,
    updated_at: updatedAt,
    ...(lastDone === undefined ? {} : { last_done: lastDone }),
    ...(status === undefined ? {} : { status }),
    ...(nextCheck === undefined ? {} : { next_check: nextCheck }),
    ...(legacyId === undefined ? {} : { legacy_long_task_id: legacyId }),
  };
}

export function validateMasterPlanDocument(value: unknown): MasterPlanDocument {
  const record = requireRecord(value, "master");
  assertKnownKeys(record, DOCUMENT_KEYS, "master");
  if (record["schema"] !== MASTER_SCHEMA) {
    throw new MasterPlanValidationError(
      "schema",
      `只支持 ${String(MASTER_SCHEMA)}: ${describe(record["schema"])}`,
    );
  }
  if (record["kind"] !== "master-plan") {
    throw new MasterPlanValidationError("kind", `必须是 "master-plan": ${describe(record["kind"])}`);
  }
  const timezone = requireTimezone(record["timezone"], "timezone");
  const version = requireVersion(record["version"], "version");
  const createdAt = requireTimestamp(record["created_at"], "created_at");
  const updatedAt = requireTimestamp(record["updated_at"], "updated_at");
  if (updatedAt < createdAt) {
    throw new MasterPlanValidationError("updated_at", "不得早于 created_at");
  }
  const rawEntries = record["entries"];
  if (!Array.isArray(rawEntries)) {
    throw new MasterPlanValidationError("entries", `必须是数组: ${describe(rawEntries)}`);
  }
  const entries = rawEntries.map((entry, index) =>
    validateMasterEntry(entry, `entries[${String(index)}]`),
  );
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      throw new MasterPlanValidationError("entries.id", `重复 id: ${entry.id}`);
    }
    seen.add(entry.id);
  }
  return {
    schema: MASTER_SCHEMA,
    kind: "master-plan",
    timezone,
    version,
    created_at: createdAt,
    updated_at: updatedAt,
    entries,
  };
}

/* ───────────────────────── 到期物化 ───────────────────────── */

function weekdayIndex(day: string | number): number {
  if (typeof day === "number") return day === 7 ? 0 : day;
  const token = day.trim().toLowerCase();
  const numeric = Number(token);
  if (Number.isInteger(numeric) && token !== "") return numeric === 7 ? 0 : numeric;
  switch (token.slice(0, 3)) {
    case "sun":
      return 0;
    case "mon":
      return 1;
    case "tue":
      return 2;
    case "wed":
      return 3;
    case "thu":
      return 4;
    case "fri":
      return 5;
    default:
      return 6;
  }
}

function scheduleMatches(schedule: MasterSchedule, dateKey: string): boolean {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  switch (schedule.kind) {
    case "daily":
      return true;
    case "weekly": {
      const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      return schedule.days.some((candidate) => weekdayIndex(candidate) === weekday);
    }
    case "monthly":
      return schedule.days.some((candidate) => Number(candidate) === day);
    case "once":
      return schedule.date === dateKey;
  }
}

/** 返回指定日期应进入当日计划的条目；只读，不修改 doc 或条目。 */
export function materializeMasterEntries(
  doc: MasterPlanDocument,
  dateKey: string,
): readonly MasterEntry[] {
  const date = requireMasterDate(dateKey, "dateKey");
  return doc.entries.filter((entry) => {
    if (!entry.enabled) return false;
    if (entry.kind === "long_term") {
      if (entry.status !== "active") return false;
      if (entry.next_check === undefined || entry.next_check > date) return false;
    }
    return scheduleMatches(entry.schedule, date);
  });
}

/* ───────────────────────── 显式编辑 op ───────────────────────── */

function validateMasterEntryPatch(value: unknown, field: string): MasterEntryPatch {
  const record = requireRecord(value, field);
  assertKnownKeys(record, PATCH_KEYS, field);
  if (Object.keys(record).length === 0) {
    throw new MasterPlanValidationError(field, "至少需要一个修改字段");
  }
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    const raw = record[key];
    if (raw === null) {
      patch[key] = null;
      continue;
    }
    switch (key) {
      case "title":
        patch[key] = requireNonEmptyString(raw, `${field}.${key}`);
        break;
      case "intent":
      case "instruction":
      case "window":
      case "done_when":
      case "legacy_long_task_id":
        patch[key] = requireNonEmptyString(raw, `${field}.${key}`);
        break;
      case "enabled":
        patch[key] = requireBoolean(raw, `${field}.${key}`);
        break;
      case "action":
        if (!isWakeAction(raw)) {
          throw new MasterPlanValidationError(`${field}.${key}`, `未知唤醒动作: ${describe(raw)}`);
        }
        patch[key] = raw;
        break;
      case "schedule":
        patch[key] = validateMasterSchedule(raw, `${field}.${key}`);
        break;
      case "target_date":
        patch[key] = requireEnum(raw, MASTER_TARGET_DATES, `${field}.${key}`);
        break;
      case "last_done":
      case "next_check":
        patch[key] = requireMasterDate(raw, `${field}.${key}`);
        break;
      case "status":
        patch[key] = requireEnum(raw, MASTER_STATUSES, `${field}.${key}`);
        break;
      case "payload":
        patch[key] = raw;
        break;
      default:
        throw new MasterPlanValidationError(`${field}.${key}`, "不允许修改该字段");
    }
  }
  if (
    typeof patch["target_date"] === "string" &&
    patch["target_date"] === "previous_day" &&
    patch["action"] !== undefined &&
    patch["action"] !== "coverage.run"
  ) {
    throw new MasterPlanValidationError(`${field}.target_date`, "previous_day 只允许用于 coverage.run");
  }
  return patch as MasterEntryPatch;
}

function validateEditOp(value: unknown, field: string): MasterEditOp {
  const record = requireRecord(value, field);
  const op = requireNonEmptyString(record["op"], `${field}.op`);
  switch (op) {
    case "upsert_entry": {
      assertKnownKeys(record, ["op", "entry"], field);
      return { op, entry: validateMasterEntry(record["entry"], `${field}.entry`) };
    }
    case "replace_entry": {
      assertKnownKeys(record, ["op", "entry"], field);
      return { op, entry: validateMasterEntry(record["entry"], `${field}.entry`) };
    }
    case "remove_entry": {
      assertKnownKeys(record, ["op", "id"], field);
      return { op, id: requireStringId(record["id"], `${field}.id`) };
    }
    case "set_enabled": {
      assertKnownKeys(record, ["op", "id", "enabled"], field);
      return {
        op,
        id: requireStringId(record["id"], `${field}.id`),
        enabled: requireBoolean(record["enabled"], `${field}.enabled`),
      };
    }
    case "set_status": {
      assertKnownKeys(record, ["op", "id", "status"], field);
      return {
        op,
        id: requireStringId(record["id"], `${field}.id`),
        status: requireEnum(record["status"], MASTER_STATUSES, `${field}.status`),
      };
    }
    case "update_entry": {
      assertKnownKeys(record, ["op", "id", "patch"], field);
      return {
        op,
        id: requireStringId(record["id"], `${field}.id`),
        patch: validateMasterEntryPatch(record["patch"], `${field}.patch`),
      };
    }
    default:
      throw new MasterPlanValidationError(`${field}.op`, `未知编辑操作: ${op}`);
  }
}

export function validateMasterEditOps(value: unknown): readonly MasterEditOp[] {
  if (!Array.isArray(value)) {
    throw new MasterPlanValidationError("ops", `必须是数组: ${describe(value)}`);
  }
  if (value.length === 0) {
    throw new MasterPlanValidationError("ops", "至少需要一个编辑操作");
  }
  return value.map((op, index) => validateEditOp(op, `ops[${String(index)}]`));
}

function mergePatch(entry: MasterEntry, patch: MasterEntryPatch): MasterEntry {
  const merged: Record<string, unknown> = { ...entry };
  for (const key of PATCH_KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return validateMasterEntry(merged, `entries.${entry.id}`);
}

/** 应用编辑 op（纯函数）；触及的条目 updated_at 统一推进到 now。 */
export function applyMasterEditOps(
  doc: MasterPlanDocument,
  ops: readonly MasterEditOp[],
  now: number,
): readonly MasterEntry[] {
  let entries = [...doc.entries];
  const touch = (entry: MasterEntry): MasterEntry => ({
    ...entry,
    updated_at: now,
  });
  for (const op of ops) {
    switch (op.op) {
      case "upsert_entry":
      case "replace_entry": {
        const at = entries.findIndex((entry) => entry.id === op.entry.id);
        const replacement = touch(op.entry);
        entries =
          at === -1
            ? [...entries, replacement]
            : entries.map((entry, index) => (index === at ? replacement : entry));
        break;
      }
      case "remove_entry": {
        if (!entries.some((entry) => entry.id === op.id)) {
          throw new MasterPlanValidationError("ops.remove_entry", `条目不存在: ${op.id}`);
        }
        entries = entries.filter((entry) => entry.id !== op.id);
        break;
      }
      case "set_enabled": {
        const at = entries.findIndex((entry) => entry.id === op.id);
        if (at === -1) {
          throw new MasterPlanValidationError("ops.set_enabled", `条目不存在: ${op.id}`);
        }
        entries = entries.map((entry, index) =>
          index === at ? touch({ ...entry, enabled: op.enabled }) : entry,
        );
        break;
      }
      case "set_status": {
        const at = entries.findIndex((entry) => entry.id === op.id);
        if (at === -1) {
          throw new MasterPlanValidationError("ops.set_status", `条目不存在: ${op.id}`);
        }
        entries = entries.map((entry, index) =>
          index === at ? touch({ ...entry, status: op.status }) : entry,
        );
        break;
      }
      case "update_entry": {
        const at = entries.findIndex((entry) => entry.id === op.id);
        if (at === -1) {
          throw new MasterPlanValidationError("ops.update_entry", `条目不存在: ${op.id}`);
        }
        const merged = mergePatch(entries[at] as MasterEntry, op.patch);
        entries = entries.map((entry, index) => (index === at ? touch(merged) : entry));
        break;
      }
    }
  }
  return entries;
}

/* ───────────────────────── Markdown 渲染 ───────────────────────── */

function renderSchedule(schedule: MasterSchedule): string {
  switch (schedule.kind) {
    case "daily":
      return `daily ${schedule.at}`;
    case "weekly":
      return `weekly ${schedule.days.join(",")} ${schedule.at}`;
    case "monthly":
      return `monthly ${schedule.days.join(",")} ${schedule.at}`;
    case "once":
      return `once ${schedule.date} ${schedule.at}`;
  }
}

function renderInstruction(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n/g, "\n  ");
}

/** 由 JSON 渲染人读 master.md；条目顺序完全由文档决定。 */
export function renderMasterMarkdown(doc: MasterPlanDocument): string {
  const lines: string[] = ["# Master Plan", ""];
  lines.push(`- schema: ${String(doc.schema)}`);
  lines.push("- kind: master-plan");
  lines.push(`- timezone: ${doc.timezone}`);
  lines.push(`- version: ${String(doc.version)}`);
  lines.push(`- created_at: ${new Date(doc.created_at).toISOString()}`);
  lines.push(`- updated_at: ${new Date(doc.updated_at).toISOString()}`);
  lines.push(`- entries: ${String(doc.entries.length)}`);
  lines.push("", "## Entries", "");
  for (const entry of doc.entries) {
    lines.push(`### ${entry.id} [${entry.kind}] ${entry.title}`, "");
    lines.push(`- enabled: ${String(entry.enabled)}`);
    if (entry.action !== undefined) lines.push(`- action: ${entry.action}`);
    lines.push(`- schedule: ${renderSchedule(entry.schedule)}`);
    if (entry.target_date !== undefined) lines.push(`- target_date: ${entry.target_date}`);
    if (entry.window !== undefined) lines.push(`- window: ${entry.window}`);
    if (entry.intent !== undefined) lines.push(`- intent: ${entry.intent}`);
    if (entry.done_when !== undefined) lines.push(`- done_when: ${entry.done_when}`);
    if (entry.status !== undefined) lines.push(`- status: ${entry.status}`);
    if (entry.next_check !== undefined) lines.push(`- next_check: ${entry.next_check}`);
    if (entry.last_done !== undefined) lines.push(`- last_done: ${entry.last_done}`);
    if (entry.legacy_long_task_id !== undefined) {
      lines.push(`- legacy_long_task_id: ${entry.legacy_long_task_id}`);
    }
    if (entry.instruction !== undefined) {
      lines.push(`- instruction: ${renderInstruction(entry.instruction)}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
