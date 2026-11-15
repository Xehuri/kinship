/**
 * v1 旧日计划（legacy）的只读回退：读盘 + 与母版合并成有效视图。
 *
 * Loom v1 真源 `{planRoot}/daily/{date}/plan-{date}.json` 只读，永不写入；
 * 读取形状与 json-plan-overlay-store.ts 的 `#readLegacy` 同口径。
 *
 * 磁盘上实际存在两种形状，读侧必须两级兼容、绝不因为形状不同丢掉当天计划：
 *   1. Loom v1 形状（带 coverage）—— 严格走 validatePlanDocument，原样返回；
 *   2. dsh 形状（`kinship-plan` 插件写出：无 coverage、带 carry_over、
 *      items 无 title/at）—— 按下面 coerceDshPlanDocument 的规则归一成
 *      PlanDocument，并计入 `legacy_coerced` 告警。
 * 两种形状都不成立时才抛 PlanValidationError（排班器退化为只用母版，安全结果）。
 *
 * dsh 适配差异（其余照抄 Loom 的 `effectiveFromLegacyPlan`）：Loom 在无覆盖层时
 * 用旧计划整体替换当日视图；dsh 下旧计划不得遮蔽母版排班，因此先物化母版条目，
 * 再把旧计划条目按覆盖层 add 语义追加（source = "legacy"），撞 id 的跳过并记
 * `legacy_collision:<id>` 告警。旧计划条目没有唤醒时刻（at 恒 undefined），
 * 排班器因此把它们计为 no_time，不会凭空产生唤醒。
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { materializeMasterEntries, type MasterEntry, type MasterPlanDocument } from "./master-plan.js";
import type { EffectivePlan, EffectivePlanEntry } from "./plan-overlay.js";
import {
  PLAN_DEFAULT_REVIEW_AT,
  PLAN_ITEM_KINDS,
  PLAN_ITEM_STATUSES,
  PLAN_SCHEMA,
  PLAN_STATUSES,
  PlanValidationError,
  requireExpectedVersion,
  requirePlanDate,
  requireReviewAt,
  validatePlanDocument,
  type PlanCoverage,
  type PlanDocument,
  type PlanItem,
  type PlanItemKind,
  type PlanItemStatus,
  type PlanStatus,
} from "./plan-store.js";

/**
 * 有效条目在 dsh 侧多一个来源值：v1 旧计划条目标记为 legacy。
 * EffectivePlanEntry.source 的类型仍是 "master" | "overlay"（上游原样保留），
 * 因此只在返回边界做一次显式收窄，不改动任何已导出类型。
 */
type PlanEntrySource = EffectivePlanEntry["source"] | "legacy";

type PlanEntryWithLegacySource = Omit<EffectivePlanEntry, "source"> & {
  readonly source: PlanEntrySource;
};

/** plan-store.ts 的 ITEM_ID_RE 未导出，这里保持同一规则（id 合法字符与长度）。 */
const ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * dsh 兼容产物登记表：coerce 后的文档刻意保留 dsh 的宽松取值（例如空 intent、
 * 空 coverage.checkpoints），形状本身并不满足 Loom 严格校验，无法再靠
 * validatePlanDocument 反推来源。这里按对象身份记录，读到同一对象即知是兼容层
 * 产物；仅在进程内生效，不写盘、不影响序列化与 Object.keys 校验。
 */
const coercedDocuments = new WeakSet<PlanDocument>();

export interface LegacyPlanReadResult {
  readonly document: PlanDocument;
  readonly coerced: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** 解析 `{planRoot}/daily/{date}/plan-{date}.json`；planRoot 必须是绝对路径。 */
function legacyPlanPath(planRoot: string, date: string): string {
  if (typeof planRoot !== "string" || planRoot.trim() === "") {
    throw new PlanValidationError("planRoot", "必须是非空绝对路径");
  }
  if (!isAbsolute(planRoot)) {
    throw new PlanValidationError("planRoot", `必须是绝对路径（绝不猜测默认根）: ${planRoot}`);
  }
  const day = requirePlanDate(date);
  return join(resolve(planRoot), "daily", day, `plan-${day}.json`);
}

/* ───────────────────────── dsh 形状兼容（第二级读取） ───────────────────────── */

function coerceEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new PlanValidationError(field, `必须是 ${allowed.join("/")}: ${describeValue(value)}`);
}

function coerceTimestamp(value: unknown, field: string): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new PlanValidationError(field, `必须是非负整数毫秒时间戳: ${describeValue(value)}`);
  }
  return value;
}

/** review_at：缺省或不是 HH:MM 时回落默认值（兼容层不因展示字段失败）。 */
function coerceReviewAt(value: unknown): string {
  if (value === undefined) return PLAN_DEFAULT_REVIEW_AT;
  try {
    return requireReviewAt(value);
  } catch {
    return PLAN_DEFAULT_REVIEW_AT;
  }
}

/** notes：非数组按缺省空表处理，非字符串元素丢弃。 */
function coerceNotes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is string => typeof row === "string");
}

/** 可选字符串字段：只接受非空字符串，其余一律视为缺省。 */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** not_do：只接受全字符串数组，否则视为缺省。 */
function optionalStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((row): row is string => typeof row === "string")
    ? (value as readonly string[])
    : undefined;
}

/** target_date：只接受合法日历日期，否则视为缺省。 */
function optionalItemDate(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return requirePlanDate(value, "target_date");
  } catch {
    return undefined;
  }
}

/**
 * dsh 条目 -> PlanItem：只保留 Loom v1 认识的字段，extras/source/done_at/evidence
 * 等一律丢弃。结构性字段（id/kind/status/intent 类型）不合法才抛错。
 */
function coerceDshPlanItem(value: unknown, field: string): PlanItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlanValidationError(field, `条目必须是对象: ${describeValue(value)}`);
  }
  const record = value as Record<string, unknown>;
  const id = record["id"];
  if (typeof id !== "string" || !ITEM_ID_RE.test(id)) {
    throw new PlanValidationError(`${field}.id`, `必须匹配 ${ITEM_ID_RE.source}: ${describeValue(id)}`);
  }
  const kind: PlanItemKind = coerceEnum(record["kind"], PLAN_ITEM_KINDS, `${field}.kind`);
  const status: PlanItemStatus = coerceEnum(
    record["status"],
    PLAN_ITEM_STATUSES,
    `${field}.status`,
  );
  const rawIntent = record["intent"];
  if (rawIntent !== undefined && typeof rawIntent !== "string") {
    throw new PlanValidationError(`${field}.intent`, `必须是字符串: ${describeValue(rawIntent)}`);
  }
  const targetDate = optionalItemDate(record["target_date"]);
  const window = optionalString(record["window"]);
  const checkpointId = optionalString(record["checkpoint_id"]);
  const doneWhen = optionalString(record["done_when"]);
  const notDo = optionalStringArray(record["not_do"]);
  const note = optionalString(record["note"]);
  return {
    id,
    kind,
    intent: rawIntent ?? "",
    status,
    ...(targetDate === undefined ? {} : { target_date: targetDate }),
    ...(window === undefined ? {} : { window }),
    ...(checkpointId === undefined ? {} : { checkpoint_id: checkpointId }),
    ...(doneWhen === undefined ? {} : { done_when: doneWhen }),
    ...(notDo === undefined ? {} : { not_do: notDo }),
    ...(note === undefined ? {} : { note }),
  };
}

/**
 * dsh 文档 -> PlanDocument。缺省口径：status 'committed'、version 1、
 * created_at/updated_at 0、notes []、coverage { merged_7, [], [] }；
 * carry_over 与所有未知键（含 title/at 等 Loom 容器外的键）一律丢弃。
 */
function coerceDshPlanDocument(value: unknown, expectedDate: string): PlanDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlanValidationError("plan", `dsh 计划必须是对象: ${describeValue(value)}`);
  }
  const record = value as Record<string, unknown>;
  const rawDate = record["date"];
  const date = rawDate === undefined ? expectedDate : requirePlanDate(rawDate, "date");
  if (date !== expectedDate) {
    throw new PlanValidationError("date", `文件日期 ${date} 与请求日期 ${expectedDate} 不一致`);
  }
  const rawStatus = record["status"];
  const status: PlanStatus =
    rawStatus === undefined ? "committed" : coerceEnum(rawStatus, PLAN_STATUSES, "status");
  const rawVersion = record["version"];
  const version =
    rawVersion === undefined ? 1 : requireExpectedVersion(rawVersion, "version");
  const createdAt = coerceTimestamp(record["created_at"], "created_at");
  const updatedAt = coerceTimestamp(record["updated_at"], "updated_at");
  const reviewAt = coerceReviewAt(record["review_at"]);
  const rawItems = record["items"];
  if (!Array.isArray(rawItems)) {
    throw new PlanValidationError("items", `dsh 计划 items 必须是数组: ${describeValue(rawItems)}`);
  }
  const items = rawItems.map((item, index) => coerceDshPlanItem(item, `items[${String(index)}]`));
  const coverage: PlanCoverage = { profile: "merged_7", checkpoints: [], debt: [] };
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
    notes: coerceNotes(record["notes"]),
  };
}

/* ───────────────────────── 读盘 ───────────────────────── */

/**
 * Read `{planRoot}/daily/{date}/plan-{date}.json` (Loom v1 legacy plan); absent -> null.
 * Throws PlanValidationError on corrupt JSON/schema（两种形状都不成立时）。
 * 返回结果的 `coerced` 标记第二级（dsh 形状）兼容是否生效。
 */
export function readLegacyPlanDetailed(
  planRoot: string,
  date: string,
): LegacyPlanReadResult | null {
  const path = legacyPlanPath(planRoot, date);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new PlanValidationError("json", `无法解析 legacy 计划 ${path}: ${errorMessage(error)}`);
  }
  const day = requirePlanDate(date);
  try {
    return { document: validatePlanDocument(parsed, day), coerced: false };
  } catch (strictError) {
    try {
      const document = coerceDshPlanDocument(parsed, day);
      coercedDocuments.add(document);
      return { document, coerced: true };
    } catch (coerceError) {
      throw new PlanValidationError(
        "plan",
        `既非 Loom v1 计划（${errorMessage(strictError)}），也无法按 dsh 计划兼容（${errorMessage(coerceError)}）`,
      );
    }
  }
}

/** Read `{planRoot}/daily/{date}/plan-{date}.json` (Loom v1 legacy plan); absent -> null. Throws PlanValidationError on corrupt JSON/schema. */
export function readLegacyPlan(planRoot: string, date: string): PlanDocument | null {
  const read = readLegacyPlanDetailed(planRoot, date);
  return read === null ? null : read.document;
}

/* ───────────────────────── 有效视图 ───────────────────────── */

/** 母版条目 -> 有效条目：字段映射与 plan-overlay.ts 的 fromMasterEntry 完全一致。 */
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

/** 旧计划条目 -> 有效条目：与 Loom `effectiveFromLegacyPlan` 同字段，仅 source 记为 legacy。 */
function fromLegacyItem(
  item: PlanItem,
  masterVersion: number,
  overlayVersion: number,
): PlanEntryWithLegacySource {
  return {
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
    source: "legacy",
    suppressed: false,
    master_version: masterVersion,
    overlay_version: overlayVersion,
  };
}

/**
 * dsh adaptation: a legacy daily plan must not hide the master schedule.
 * Base entries = materializeMasterEntries(master, date); each legacy item is
 * appended as an overlay-style add (source 'legacy') unless its id already
 * exists in the base, in which case it is skipped and a
 * `legacy_collision:<id>` warning is recorded. Legacy items have no wake time
 * (`at` undefined) so the scheduler counts them as no_time.
 *
 * warnings 顺序固定：legacy_fallback、legacy_coerced（读盘走了 dsh 兼容层时）、
 * 再按条目顺序的 legacy_collision:<id>。
 */
export function effectiveFromLegacyPlanWithMaster(
  legacy: PlanDocument,
  master: MasterPlanDocument,
): EffectivePlan {
  const coerced = coercedDocuments.has(legacy);
  // 兼容层产物已按 PlanDocument 归一，但刻意保留 dsh 的宽松取值（空 intent、
  // 空 coverage.checkpoints），回灌 Loom 严格校验必然误报；Loom v1 文档仍严格校验。
  const document = coerced ? legacy : validatePlanDocument(legacy);
  const base = materializeMasterEntries(master, document.date).map((entry) =>
    fromMasterEntry(entry, master.version, document.version),
  );
  const entries: PlanEntryWithLegacySource[] = [...base];
  const known = new Set(entries.map((entry) => entry.id));
  const warnings: string[] = ["legacy_fallback"];
  if (coerced) warnings.push("legacy_coerced");
  for (const item of document.items) {
    if (known.has(item.id)) {
      warnings.push(`legacy_collision:${item.id}`);
      continue;
    }
    known.add(item.id);
    entries.push(fromLegacyItem(item, master.version, document.version));
  }
  return {
    date: document.date,
    origin: "legacy",
    status: document.status,
    base_version: master.version,
    master_version: master.version,
    overlay_version: document.version,
    coverage: document.coverage,
    entries: entries as readonly EffectivePlanEntry[],
    notes: [...document.notes],
    warnings,
  };
}
