/**
 * plan 覆盖层工具（T07）—— 日计划 diff 的唯一模型入口。
 *
 * 母版是持久真源；当日计划只是 `{planRoot}/daily/{date}` 下的 diff 覆盖层。
 * 七个动作全部经 T06 JsonPlanOverlayStore 落盘（内部复用 T04/T02 的原子写
 * 与文件锁），本文件不拼路径、不直接写盘；账本只经 PlanLedger 追加。
 *
 *   read   母版 + 覆盖层 + 有效视图 + 昨日遗留 + 账本尾
 *   base   当日母版物化条目 + 昨日遗留（diff 的输入）
 *   diff   首次创建走 write->commit；已有覆盖层走 CAS revise->commit
 *   revise CAS 修订，不重新核对 base_version
 *   done   只改覆盖层：一条 update op + 恰好一行账本；绝不写母版
 *   note   覆盖层追加笔记
 *   close  覆盖层收口（未完成条目转 carried），绝不写母版
 *
 * 错误面：所有失败（参数、CAS、not-found、closed、锁超时、校验器缺失等）
 * 一律折叠为 isError 工具结果回灌模型，不抛、不中断 run。
 */

import { Type } from "@axeuh/loom-core";
import type { HarnessTool, HookContext, ToolExecResult } from "@axeuh/loom-core";

import {
  JsonPlanOverlayStore,
  type MasterPlanReader,
} from "../plan/json-plan-overlay-store.js";
import {
  materializeMasterEntries,
  type MasterEntry,
  type MasterPlanDocument,
} from "../plan/master-plan.js";
import { PlanLedger, type PlanLedgerRow } from "../plan/plan-ledger.js";
import {
  OVERLAY_SCHEMA,
  OverlayBaseStaleError,
  PlanOverlayClosedError,
  PlanOverlayNotFoundError,
  PlanOverlayValidationError,
  mergeOverlay,
  requireOverlayDate,
  validatePlanOverlayAgainstMaster,
  validatePlanOverlayReviseInput,
  validatePlanOverlayWriteInput,
  type EffectivePlan,
  type EffectivePlanEntry,
  type PlanOverlayDocument,
  type PlanOverlayItem,
  type PlanOverlayOp,
  type PlanOverlayPatch,
} from "../plan/plan-overlay.js";
import {
  PLAN_ITEM_KINDS,
  PLAN_ITEM_STATUSES,
  type PlanCoverage,
  type PlanItemStatus,
} from "../plan/plan-store.js";
import { addDays } from "../plan/timezone.js";
import { renderPlanOverlayText, type PlanEntryFilter } from "./plan-overlay-text.js";

export const PLAN_OVERLAY_TOOL_NAME = "plan" as const;

export const PLAN_OVERLAY_TOOL_ACTIONS = [
  "read",
  "base",
  "diff",
  "revise",
  "done",
  "note",
  "close",
] as const;
export type PlanOverlayToolAction = (typeof PLAN_OVERLAY_TOOL_ACTIONS)[number];

export const PLAN_DONE_STATUSES = ["done", "blocked", "skipped", "carried"] as const;
export type PlanDoneStatus = (typeof PLAN_DONE_STATUSES)[number];

/** read/base 的 kind 过滤器：PLAN_ITEM_KINDS + anchor 别名（匹配母版锚点/覆盖）。 */
const PLAN_FILTER_KINDS = [...PLAN_ITEM_KINDS, "anchor"] as const;

/** 昨日遗留：昨日有效视图里尚未 done 的条目（carried/planned/blocked/skipped）。 */
export interface PlanLeftoverItem {
  readonly source_date: string;
  readonly id: string;
  readonly kind: string;
  readonly status: PlanItemStatus;
  readonly title?: string;
  readonly intent?: string;
  readonly at?: string;
  readonly window?: string;
  readonly done_when?: string;
  readonly evidence?: string;
}

export interface PlanReadResult {
  readonly date: string;
  readonly master: MasterPlanDocument;
  readonly overlay: PlanOverlayDocument | null;
  readonly effective: EffectivePlan | null;
  readonly leftovers: readonly PlanLeftoverItem[];
  readonly ledger_tail: readonly PlanLedgerRow[];
}

export interface PlanBaseResult {
  readonly date: string;
  readonly master_version: number;
  readonly base_version: number;
  readonly items: readonly MasterEntry[];
  readonly leftovers: readonly PlanLeftoverItem[];
}

export interface PlanDiffResult {
  readonly date: string;
  readonly overlay: PlanOverlayDocument;
  readonly effective: EffectivePlan;
  readonly ledger: PlanLedgerRow;
}

export interface PlanDoneResult {
  readonly date: string;
  readonly id: string;
  readonly status: PlanDoneStatus;
  readonly overlay: PlanOverlayDocument;
  readonly effective: EffectivePlan;
  readonly ledger: PlanLedgerRow;
}

export interface PlanCloseResult {
  readonly date: string;
  readonly overlay: PlanOverlayDocument;
  readonly effective: EffectivePlan;
  readonly carried: readonly EffectivePlanEntry[];
  readonly ledger: PlanLedgerRow;
}

export interface PlanCoverageVerificationInput {
  readonly date: string;
  readonly id: string;
  readonly status: PlanDoneStatus;
  readonly entry: EffectivePlanEntry;
}

export interface PlanCoverageVerification {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * T09 注入的覆盖校验器。工具层只依赖这个窄接口，不实现任何校验逻辑；
 * 未配置时 verify=coverage 直接返回类型化 isError。
 */
export interface PlanCoverageVerifier {
  verify(
    input: PlanCoverageVerificationInput,
  ): PlanCoverageVerification | Promise<PlanCoverageVerification>;
}

export class PlanCoverageVerifierUnavailableError extends Error {
  constructor() {
    super(
      "[plan-tool:verifier-unavailable] verify=coverage 已请求，但未配置覆盖校验器（T09 注入）",
    );
    this.name = "PlanCoverageVerifierUnavailableError";
  }
}

export class PlanDoneVerificationError extends Error {
  constructor(message: string) {
    super(`[plan-tool:verification] ${message}`);
    this.name = "PlanDoneVerificationError";
  }
}

export interface PlanOverlayToolOptions {
  readonly overlayStore: JsonPlanOverlayStore;
  readonly master: MasterPlanReader;
  readonly ledger: PlanLedger;
  readonly verifier?: PlanCoverageVerifier;
  readonly now?: () => number;
}

const DEFAULT_COVERAGE: PlanCoverage = {
  profile: "merged_7",
  checkpoints: ["cov-00", "cov-06", "cov-08", "cov-12", "cov-16", "cov-20", "cov-22"],
  debt: [],
};

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const LEDGER_TAIL_LIMIT = 20;

/* ───────────────────────── 参数解析 ───────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
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

function requireInteger(value: unknown, field: string, min = 1): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new PlanOverlayValidationError(field, `必须是 >=${String(min)} 的整数: ${describe(value)}`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new PlanOverlayValidationError(field, `必须是布尔值: ${describe(value)}`);
  }
  return value;
}

function requireAction(value: unknown): PlanOverlayToolAction {
  if (
    typeof value !== "string" ||
    !(PLAN_OVERLAY_TOOL_ACTIONS as readonly string[]).includes(value)
  ) {
    throw new PlanOverlayValidationError(
      "action",
      `必须是 ${PLAN_OVERLAY_TOOL_ACTIONS.join(" | ")} 之一: ${describe(value)}`,
    );
  }
  return value as PlanOverlayToolAction;
}

function requireId(value: unknown, field: string): string {
  const id = requireNonEmptyString(value, field);
  if (!ID_RE.test(id)) {
    throw new PlanOverlayValidationError(field, `必须匹配 ${ID_RE.source}: ${id}`);
  }
  return id;
}

function requireDoneStatus(value: unknown): PlanDoneStatus {
  if (
    typeof value !== "string" ||
    !(PLAN_DONE_STATUSES as readonly string[]).includes(value)
  ) {
    throw new PlanOverlayValidationError(
      "status",
      `必须是 ${PLAN_DONE_STATUSES.join(" | ")} 之一: ${describe(value)}`,
    );
  }
  return value as PlanDoneStatus;
}

function parseVerify(value: unknown): "coverage" | undefined {
  if (value === undefined) return undefined;
  if (value !== "coverage") {
    throw new PlanOverlayValidationError("verify", `只支持 "coverage": ${describe(value)}`);
  }
  return "coverage";
}

function requireOps(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new PlanOverlayValidationError("ops", `必须是数组: ${describe(value)}`);
  }
  return value;
}

function parseIncludeInstruction(value: unknown): boolean | readonly string[] {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value as readonly string[];
  }
  throw new PlanOverlayValidationError("include_instruction", "必须是布尔值或字符串数组");
}

function parseFilterValues(
  value: unknown,
  field: "status" | "kind",
  allowed: readonly string[],
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const items = Array.isArray(value) ? value : [value];
  if (items.length === 0) {
    throw new PlanOverlayValidationError(field, `不能是空数组: ${describe(value)}`);
  }
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of items) {
    if (typeof item !== "string" || !allowed.includes(item)) {
      throw new PlanOverlayValidationError(
        field,
        `必须是 ${allowed.join(" | ")} 之一: ${describe(item)}`,
      );
    }
    if (seen.has(item)) continue;
    seen.add(item);
    values.push(item);
  }
  return values;
}

/** read/base 的条目过滤器；其他动作忽略 status/kind。 */
function parseEntryFilter(args: Record<string, unknown>): PlanEntryFilter | undefined {
  const status = parseFilterValues(args["status"], "status", PLAN_ITEM_STATUSES);
  const kind = parseFilterValues(args["kind"], "kind", PLAN_FILTER_KINDS);
  if (status === undefined && kind === undefined) return undefined;
  return {
    ...(status === undefined ? {} : { status }),
    ...(kind === undefined ? {} : { kind }),
  };
}

function requireDateTime(now: () => number): string {
  const at = now();
  if (!Number.isInteger(at) || at < 0) {
    throw new PlanOverlayValidationError("now", `时钟必须返回非负整数毫秒: ${String(at)}`);
  }
  return new Date(at).toISOString();
}

/* ───────────────────────── 覆盖层 op 维护 ───────────────────────── */

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

function applyItemPatch(item: PlanOverlayItem, patch: PlanOverlayPatch): PlanOverlayItem {
  const next: Record<string, unknown> = { ...item };
  for (const key of Object.keys(patch) as (keyof PlanOverlayPatch)[]) {
    const value = patch[key];
    if (value === null) {
      delete next[key];
      continue;
    }
    if (value !== undefined) next[key] = value;
  }
  return next as unknown as PlanOverlayItem;
}

function mergePatch(base: PlanOverlayPatch, patch: PlanOverlayPatch): PlanOverlayPatch {
  return { ...base, ...patch };
}

/**
 * 把某条目的 update 写进 ops 列表：已有同 id 的 add/update 就地合并，
 * 保证 ops 的「一个 id 最多一个 op」不变量不被破坏。
 */
function upsertEntryPatch(
  ops: readonly PlanOverlayOp[],
  id: string,
  patch: PlanOverlayPatch,
): readonly PlanOverlayOp[] {
  const index = ops.findIndex((op) => opTargetId(op) === id);
  if (index === -1) return [...ops, { op: "update", id, patch }];
  const existing = ops[index];
  if (existing === undefined) return [...ops, { op: "update", id, patch }];
  const next = [...ops];
  switch (existing.op) {
    case "add":
      next[index] = { op: "add", item: applyItemPatch(existing.item, patch) };
      return next;
    case "update":
      next[index] = { op: "update", id, patch: mergePatch(existing.patch, patch) };
      return next;
    case "remove":
      throw new PlanOverlayValidationError(
        `ops.${id}`,
        "条目已被当日覆盖层移除，不能更新",
      );
    case "note":
      return [...ops, { op: "update", id, patch }];
  }
}

function overlayPreview(
  master: MasterPlanDocument,
  date: string,
  ops: readonly PlanOverlayOp[],
  notes: readonly string[],
  coverage: PlanCoverage,
  version: number,
): PlanOverlayDocument {
  return {
    schema: OVERLAY_SCHEMA,
    kind: "plan-overlay",
    date,
    base_version: master.version,
    version,
    status: "draft",
    created_at: 0,
    updated_at: 0,
    ops,
    notes,
    coverage,
  };
}

/* ───────────────────────── 只读辅助 ───────────────────────── */

async function readOverlayOrNull(
  store: JsonPlanOverlayStore,
  date: string,
): Promise<PlanOverlayDocument | null> {
  try {
    return await store.read(date);
  } catch (error) {
    if (error instanceof PlanOverlayNotFoundError) return null;
    throw error;
  }
}

async function readEffectiveOrNull(
  store: JsonPlanOverlayStore,
  date: string,
): Promise<EffectivePlan | null> {
  try {
    return await store.readEffective(date);
  } catch (error) {
    if (error instanceof PlanOverlayNotFoundError) return null;
    throw error;
  }
}

const LEFTOVER_STATUSES: ReadonlySet<PlanItemStatus> = new Set([
  "planned",
  "blocked",
  "carried",
]);

function collectLeftovers(
  plan: EffectivePlan | null,
  todayIds: ReadonlySet<string>,
): readonly PlanLeftoverItem[] {
  if (plan === null) return [];
  return plan.entries
    .filter(
      (entry) =>
        !entry.suppressed &&
        LEFTOVER_STATUSES.has(entry.status) &&
        entry.action !== "plan.build" &&
        entry.action !== "plan.review" &&
        !todayIds.has(entry.id),
    )
    .map((entry) => ({
      source_date: plan.date,
      id: entry.id,
      kind: entry.kind,
      status: entry.status,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      ...(entry.intent === undefined ? {} : { intent: entry.intent }),
      ...(entry.at === undefined ? {} : { at: entry.at }),
      ...(entry.window === undefined ? {} : { window: entry.window }),
      ...(entry.done_when === undefined ? {} : { done_when: entry.done_when }),
      ...(entry.evidence === undefined ? {} : { evidence: entry.evidence }),
    }));
}

async function resolveCoverage(
  store: JsonPlanOverlayStore,
  date: string,
  explicit: unknown,
): Promise<PlanCoverage> {
  if (explicit !== undefined) return explicit as PlanCoverage;
  const yesterday = await readEffectiveOrNull(store, addDays(date, -1));
  return yesterday === null ? DEFAULT_COVERAGE : yesterday.coverage;
}

/* ───────────────────────── 动作实现 ───────────────────────── */

async function readAction(
  opts: PlanOverlayToolOptions,
  args: Record<string, unknown>,
): Promise<PlanReadResult> {
  const date = requireOverlayDate(args["date"]);
  const master = await opts.master.read();
  const overlay = await readOverlayOrNull(opts.overlayStore, date);
  const effective =
    overlay === null
      ? await readEffectiveOrNull(opts.overlayStore, date)
      : mergeOverlay(master, overlay, date);
  const yesterday = await readEffectiveOrNull(opts.overlayStore, addDays(date, -1));
  const ledgerTail = await opts.ledger.tail(date, LEDGER_TAIL_LIMIT);
  const todayIds = new Set(
    effective === null
      ? materializeMasterEntries(master, date).map((entry) => entry.id)
      : effective.entries
          .filter((entry) => !entry.suppressed)
          .map((entry) => entry.id),
  );
  return {
    date,
    master,
    overlay,
    effective,
    leftovers: collectLeftovers(yesterday, todayIds),
    ledger_tail: ledgerTail,
  };
}

async function baseAction(
  opts: PlanOverlayToolOptions,
  args: Record<string, unknown>,
): Promise<PlanBaseResult> {
  const date = requireOverlayDate(args["date"]);
  const master = await opts.master.read();
  const yesterday = await readEffectiveOrNull(opts.overlayStore, addDays(date, -1));
  const items = materializeMasterEntries(master, date);
  return {
    date,
    master_version: master.version,
    base_version: master.version,
    items,
    leftovers: collectLeftovers(yesterday, new Set(items.map((entry) => entry.id))),
  };
}

async function diffAction(
  opts: PlanOverlayToolOptions,
  args: Record<string, unknown>,
): Promise<PlanDiffResult> {
  const date = requireOverlayDate(args["date"]);
  const baseVersion = requireInteger(args["base_version"], "base_version");
  const reason = requireNonEmptyString(args["reason"], "reason");
  const master = await opts.master.read();
  if (master.version !== baseVersion) {
    throw new OverlayBaseStaleError(date, baseVersion, master.version);
  }
  const current = await readOverlayOrNull(opts.overlayStore, date);

  if (current === null) {
    const ops = requireOps(args["ops"]);
    const coverage = await resolveCoverage(opts.overlayStore, date, args["coverage"]);
    const draft = validatePlanOverlayWriteInput({
      date,
      base_version: baseVersion,
      ops,
      coverage,
      ...(args["notes"] === undefined ? {} : { notes: args["notes"] }),
      ...(args["user_intent"] === undefined ? {} : { user_intent: args["user_intent"] }),
    });
    validatePlanOverlayAgainstMaster(
      master,
      overlayPreview(master, date, draft.ops, draft.notes, draft.coverage, 1),
      date,
    );
    const created = await opts.overlayStore.write(draft);
    const committed = await opts.overlayStore.commit(date, created.version);
    const ledger = await opts.ledger.append({
      date,
      source: "plan",
      event: "diff",
      version: committed.overlay.version,
      reason,
    });
    return { date, overlay: committed.overlay, effective: committed.effective, ledger };
  }

  if (current.status === "closed") throw new PlanOverlayClosedError(date);
  if (
    args["ops"] === undefined &&
    args["user_intent"] === undefined &&
    args["notes"] === undefined &&
    args["coverage"] === undefined
  ) {
    throw new PlanOverlayValidationError(
      "ops",
      "至少提供 ops/user_intent/notes/coverage 之一",
    );
  }
  const expected =
    args["expected_version"] === undefined
      ? current.version
      : requireInteger(args["expected_version"], "expected_version");
  const patch = validatePlanOverlayReviseInput({
    base_version: baseVersion,
    ...(args["ops"] === undefined ? {} : { ops: requireOps(args["ops"]) }),
    ...(args["coverage"] === undefined ? {} : { coverage: args["coverage"] }),
    ...(args["notes"] === undefined ? {} : { notes_append: args["notes"] }),
    ...(args["user_intent"] === undefined ? {} : { user_intent: args["user_intent"] }),
  });
  const preview = overlayPreview(
    master,
    date,
    patch.ops ?? current.ops,
    [...current.notes, ...(patch.notes_append ?? [])],
    patch.coverage ?? current.coverage,
    current.version + 1,
  );
  validatePlanOverlayAgainstMaster(master, preview, date);
  const revised = await opts.overlayStore.revise(date, expected, patch);
  const committed = await opts.overlayStore.commit(date, revised.version);
  const ledger = await opts.ledger.append({
    date,
    source: "plan",
    event: "diff",
    version: committed.overlay.version,
    reason,
  });
  return { date, overlay: committed.overlay, effective: committed.effective, ledger };
}

async function reviseAction(
  opts: PlanOverlayToolOptions,
  args: Record<string, unknown>,
): Promise<PlanDiffResult> {
  const date = requireOverlayDate(args["date"]);
  const expected = requireInteger(args["expected_version"], "expected_version");
  const reason = requireNonEmptyString(args["reason"], "reason");
  const patch = validatePlanOverlayReviseInput({
    ...(args["ops"] === undefined ? {} : { ops: requireOps(args["ops"]) }),
    ...(args["user_intent"] === undefined ? {} : { user_intent: args["user_intent"] }),
  });
  const revised = await opts.overlayStore.revise(date, expected, patch);
  const master = await opts.master.read();
  const effective = mergeOverlay(master, revised, date);
  const ledger = await opts.ledger.append({
    date,
    source: "plan",
    event: "revise",
    version: revised.version,
    reason,
  });
  return { date, overlay: revised, effective, ledger };
}

async function doneAction(
  opts: PlanOverlayToolOptions,
  args: Record<string, unknown>,
): Promise<PlanDoneResult> {
  const date = requireOverlayDate(args["date"]);
  const id = requireId(args["id"], "id");
  const status = requireDoneStatus(args["status"]);
  const evidence = optionalNonEmptyString(args["evidence"], "evidence");
  const verify = parseVerify(args["verify"]);
  const force = args["force"] === undefined ? false : requireBoolean(args["force"], "force");
  if (force && evidence === undefined) {
    throw new PlanOverlayValidationError("evidence", "force:true 必须提供非空 evidence");
  }

  const current = await opts.overlayStore.read(date);
  const master = await opts.master.read();
  const effective = mergeOverlay(master, current, date);
  const entry = effective.entries.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    throw new PlanOverlayValidationError("id", `当日计划不存在条目: ${id}`);
  }

  if (verify === "coverage" && !force) {
    const verifier = opts.verifier;
    if (verifier === undefined) throw new PlanCoverageVerifierUnavailableError();
    const verdict = await verifier.verify({ date, id, status, entry });
    if (!verdict.ok) {
      throw new PlanDoneVerificationError(verdict.reason ?? `coverage 校验未通过: ${id}`);
    }
  }

  const expected =
    args["expected_version"] === undefined
      ? current.version
      : requireInteger(args["expected_version"], "expected_version");
  const now = opts.now ?? Date.now;
  const patch: PlanOverlayPatch = {
    status,
    ...(evidence === undefined ? {} : { evidence }),
    ...(status === "done" ? { done_at: requireDateTime(now) } : {}),
  };
  const ops = upsertEntryPatch(current.ops, id, patch);
  const revised = await opts.overlayStore.revise(date, expected, { ops });
  const nextEffective = mergeOverlay(master, revised, date);
  const ledger = await opts.ledger.append({
    date,
    source: "plan",
    event: force ? "override" : "done",
    entry_id: id,
    status,
    version: revised.version,
    ...(force && evidence !== undefined ? { reason: evidence } : {}),
  });
  return {
    date,
    id,
    status,
    overlay: revised,
    effective: nextEffective,
    ledger,
  };
}

async function noteAction(
  opts: PlanOverlayToolOptions,
  args: Record<string, unknown>,
): Promise<PlanDiffResult> {
  const date = requireOverlayDate(args["date"]);
  const text = requireNonEmptyString(args["text"], "text");
  const current = await opts.overlayStore.read(date);
  const revised = await opts.overlayStore.revise(date, current.version, {
    notes_append: [text],
  });
  const master = await opts.master.read();
  const effective = mergeOverlay(master, revised, date);
  const ledger = await opts.ledger.append({
    date,
    source: "plan",
    event: "note",
    version: revised.version,
    reason: text,
  });
  return { date, overlay: revised, effective, ledger };
}

async function closeAction(
  opts: PlanOverlayToolOptions,
  args: Record<string, unknown>,
): Promise<PlanCloseResult> {
  const date = requireOverlayDate(args["date"]);
  const expected = requireInteger(args["expected_version"], "expected_version");
  const summary = requireNonEmptyString(args["summary"], "summary");
  const current = await opts.overlayStore.read(date);
  const master = await opts.master.read();
  const effective = mergeOverlay(master, current, date);
  let ops = current.ops;
  const carried: EffectivePlanEntry[] = [];
  for (const entry of effective.entries) {
    if (entry.suppressed || entry.status === "done" || entry.status === "carried") continue;
    ops = upsertEntryPatch(ops, entry.id, { status: "carried" });
    carried.push({ ...entry, status: "carried" });
  }
  const revised = await opts.overlayStore.revise(date, expected, {
    ops,
    notes_append: [summary],
  });
  const closed = await opts.overlayStore.close(date, revised.version);
  const closedEffective = mergeOverlay(master, closed, date);
  const ledger = await opts.ledger.append({
    date,
    source: "plan",
    event: "close",
    version: closed.version,
    reason: summary,
  });
  return {
    date,
    overlay: closed,
    effective: closedEffective,
    carried,
    ledger,
  };
}

interface PlanActionOutcome {
  readonly action: PlanOverlayToolAction;
  readonly payload: unknown;
  readonly includeInstruction: boolean | readonly string[];
  readonly filter?: PlanEntryFilter;
}

async function runAction(
  opts: PlanOverlayToolOptions,
  args: Record<string, unknown>,
): Promise<PlanActionOutcome> {
  if (!isRecord(args)) {
    throw new PlanOverlayValidationError("args", "必须是对象");
  }
  const action = requireAction(args["action"]);
  const includeInstruction = parseIncludeInstruction(args["include_instruction"]);
  const filter = action === "read" || action === "base" ? parseEntryFilter(args) : undefined;
  switch (action) {
    case "read":
      return {
        action,
        payload: await readAction(opts, args),
        includeInstruction,
        ...(filter === undefined ? {} : { filter }),
      };
    case "base":
      return {
        action,
        payload: await baseAction(opts, args),
        includeInstruction,
        ...(filter === undefined ? {} : { filter }),
      };
    case "diff":
      return { action, payload: await diffAction(opts, args), includeInstruction };
    case "revise":
      return { action, payload: await reviseAction(opts, args), includeInstruction };
    case "done":
      return { action, payload: await doneAction(opts, args), includeInstruction };
    case "note":
      return { action, payload: await noteAction(opts, args), includeInstruction };
    case "close":
      return { action, payload: await closeAction(opts, args), includeInstruction };
  }
}

/* ───────────────────────── 结果投影 ───────────────────────── */

function successResult(
  action: PlanOverlayToolAction,
  payload: unknown,
  includeInstruction: boolean | readonly string[],
  filter?: PlanEntryFilter,
): ToolExecResult {
  return {
    content: [
      {
        type: "text",
        text: renderPlanOverlayText(action, payload, {
          includeInstruction,
          ...(filter === undefined ? {} : { filter }),
        }),
      },
    ],
    details: { __plan: payload },
  };
}

function errorResult(error: Error): ToolExecResult {
  return {
    content: [{ type: "text", text: `plan 被拒绝：${error.name}: ${error.message}` }],
    isError: true,
    details: { __plan: { error: error.name, message: error.message } },
  };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/* ───────────────────────── 参数 schema ───────────────────────── */

function planItemParameter() {
  return Type.Object({
    id: Type.String({ description: "Stable id: letters/digits/_/-, max 64 chars." }),
    kind: Type.Union([
      Type.Literal("care"),
      Type.Literal("coverage"),
      Type.Literal("review"),
      Type.Literal("long_task"),
      Type.Literal("note"),
    ]),
    intent: Type.String(),
    status: Type.Union(PLAN_ITEM_STATUSES.map((status) => Type.Literal(status))),
    at: Type.Optional(Type.String({ description: "HH:MM." })),
    action: Type.Optional(Type.String()),
    payload: Type.Optional(Type.Unknown()),
    window: Type.Optional(Type.String()),
    done_when: Type.Optional(Type.String()),
    note: Type.Optional(Type.String()),
    evidence: Type.Optional(Type.String()),
    done_at: Type.Optional(Type.String()),
    target_date: Type.Optional(Type.String({ description: "YYYY-MM-DD." })),
    checkpoint_id: Type.Optional(Type.String()),
    not_do: Type.Optional(Type.Array(Type.String())),
  });
}

function patchParameter() {
  return Type.Object({
    at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    action: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    payload: Type.Optional(Type.Unknown()),
    intent: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    window: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    done_when: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    note: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    status: Type.Optional(Type.Union(PLAN_ITEM_STATUSES.map((status) => Type.Literal(status)))),
    evidence: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    done_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  });
}

function overlayOpParameter() {
  return Type.Union([
    Type.Object({ op: Type.Literal("add"), item: planItemParameter() }),
    Type.Object({
      op: Type.Literal("update"),
      id: Type.String(),
      patch: patchParameter(),
    }),
    Type.Object({ op: Type.Literal("remove"), id: Type.String() }),
    Type.Object({ op: Type.Literal("note"), text: Type.String() }),
  ]);
}

function coverageParameter() {
  return Type.Object({
    profile: Type.Union([Type.Literal("merged_7"), Type.Literal("merged_6")]),
    checkpoints: Type.Array(Type.String()),
    debt: Type.Array(Type.String()),
  });
}

export function planOverlayToolParameters() {
  return Type.Object({
    action: Type.Union(PLAN_OVERLAY_TOOL_ACTIONS.map((action) => Type.Literal(action))),
    date: Type.String({ description: "Plan date, YYYY-MM-DD." }),
    include_instruction: Type.Optional(
      Type.Union([Type.Boolean(), Type.Array(Type.String())], {
        description:
          "read/base only. Omitted or false hides instruction bodies; true shows all; " +
          "an id array shows only those entries.",
      }),
    ),
    kind: Type.Optional(
      Type.Union(
        [
          ...PLAN_FILTER_KINDS.map((kind) => Type.Literal(kind)),
          Type.Array(
            Type.Union(PLAN_FILTER_KINDS.map((kind) => Type.Literal(kind))),
            { minItems: 1 },
          ),
        ],
        {
          description:
            "read/base only. Filter by entry kind, single value or non-empty array; " +
            '"anchor" matches master anchors/coverage.',
        },
      ),
    ),

    // diff / revise
    base_version: Type.Optional(Type.Integer({ minimum: 1 })),
    expected_version: Type.Optional(Type.Integer({ minimum: 1 })),
    ops: Type.Optional(Type.Array(overlayOpParameter())),
    notes: Type.Optional(Type.Array(Type.String())),
    coverage: Type.Optional(coverageParameter()),
    reason: Type.Optional(Type.String()),
    user_intent: Type.Optional(
      Type.String({
        description:
          "diff/revise only. Replaces the daily user intent; recording only.",
      }),
    ),

    // done
    id: Type.Optional(Type.String()),
    status: Type.Optional(
      Type.Union(
        [
          ...PLAN_ITEM_STATUSES.map((status) => Type.Literal(status)),
          Type.Array(
            Type.Union(PLAN_ITEM_STATUSES.map((status) => Type.Literal(status))),
            { minItems: 1 },
          ),
        ],
        {
          description:
            "done: status to record (done|blocked|skipped|carried); " +
            "read/base: filter by status, single value or non-empty array.",
        },
      ),
    ),
    evidence: Type.Optional(Type.String()),
    verify: Type.Optional(Type.Literal("coverage")),
    force: Type.Optional(Type.Boolean()),

    // note
    text: Type.Optional(Type.String()),

    // close
    summary: Type.Optional(Type.String()),
  });
}

const PLAN_OVERLAY_TOOL_DESCRIPTION =
  "Read and update the daily plan diff overlay. The persistent master plan is never written by this tool. " +
  "Actions: read {date, include_instruction?, status?, kind?} -> master/overlay/effective/leftovers/ledger_tail; " +
  "base {date, include_instruction?, status?, kind?} -> materialized master items + yesterday leftovers (input for diffing); " +
  "diff {date, base_version, expected_version?, ops, notes?, coverage?, reason, user_intent?} -> create or revise then CAS commit; " +
  "revise {date, expected_version, ops, reason, user_intent?} -> CAS revise without rechecking base_version; " +
  "done {date, id, status, evidence?, expected_version?, verify?, force?} -> one overlay update + exactly one ledger row " +
  "(status here is the done status, not a read/base filter; verify=coverage requires an injected verifier; " +
  "force:true requires evidence and records an override row); " +
  "note {date, text} -> append a note to the overlay; " +
  "close {date, expected_version, summary} -> overlay-only close, unfinished items become carried. " +
  "include_instruction applies to read/base: omitted or false hides instruction bodies, true shows all, " +
  "an id array shows only those entries. " +
  "status/kind filters apply to read/base text projection only (single value or non-empty array); " +
  "kind=anchor is an alias matching master anchors/coverage; details.__plan always stays complete and unfiltered. " +
  "user_intent on diff/revise replaces the daily user intent and is recording only. " +
  "care entries require a non-empty done_when with an HH:MM time, or done_when plus a non-empty window; " +
  "otherwise use kind=note. " +
  "Leftovers only include yesterday's non-suppressed planned/blocked/carried items, excluding plan.build/plan.review " +
  "and ids already present in today's plan. " +
  "All failures are returned as isError results; re-read the plan for the current version. " +
  "Output is compact plain text; call read again after a mutation to see current entries.";

export function createPlanOverlayTool(opts: PlanOverlayToolOptions): HarnessTool {
  return {
    name: PLAN_OVERLAY_TOOL_NAME,
    label: "计划",
    description: PLAN_OVERLAY_TOOL_DESCRIPTION,
    parameters: planOverlayToolParameters(),
    isReadOnly: false,
    // 同一日期的覆盖层写路径必须串行：done/close 依赖版本单调。
    isConcurrencySafe: () => false,
    async execute(
      args: Record<string, unknown>,
      _ctx: HookContext,
      _signal: AbortSignal,
    ): Promise<ToolExecResult> {
      try {
        const outcome = await runAction(opts, args);
        return successResult(
          outcome.action,
          outcome.payload,
          outcome.includeInstruction,
          outcome.filter,
        );
      } catch (error) {
        return errorResult(toError(error));
      }
    },
  };
}
