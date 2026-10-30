/**
 * plan 覆盖层的模型可读投影：把结构化结果压成紧凑纯文本。
 *
 * details.__plan 仍保留完整对象（UI/测试按结构取数）；本文件只负责
 * content[].text，省掉模型反复读同一份 master/overlay/effective JSON。
 * payload 按未知值收窄，残缺字段一律降级，不让渲染抛错。
 */

import type { PlanOverlayToolAction } from "./plan-overlay-tool.js";
import {
  clipText,
  countBy,
  formatCoverage,
  formatPayload,
  plainInline,
} from "./text-utils.js";

const LABEL_LIMIT = 80;
const EVIDENCE_LIMIT = 300;
const FIELD_LIMIT = 200;
const SUMMARY_LIMIT = 300;
const LEDGER_REASON_LIMIT = 120;
const NOTES_LIMIT = 10;
const OPS_LIMIT = 20;
const MAX_EPOCH_MS = 8.64e15;

type JsonRecord = Record<string, unknown>;

/** 条目过滤：只作用于 read/base 的条目列表，不碰 leftovers/覆盖/笔记/告警/账本。 */
export interface PlanEntryFilter {
  readonly status?: readonly string[];
  readonly kind?: readonly string[];
}

/** 渲染选项：includeInstruction 默认隐藏 instruction 正文。 */
export interface PlanOverlayRenderOptions {
  readonly includeInstruction?: boolean | readonly string[];
  readonly filter?: PlanEntryFilter;
}

/** 单次渲染的唯一 instruction 准入上下文；不落任何模块级可变状态。 */
interface RenderContext {
  readonly include: (id: string) => boolean;
}

const HIDDEN_INSTRUCTION: RenderContext = { include: () => false };

function buildRenderContext(options?: PlanOverlayRenderOptions): RenderContext {
  const value = options?.includeInstruction;
  if (value === true) return { include: () => true };
  if (Array.isArray(value)) {
    const ids = new Set(value);
    return { include: (id) => ids.has(id) };
  }
  return HIDDEN_INSTRUCTION;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordOf(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function entriesOf(value: unknown): readonly JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function valuesOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringsOf(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function inline(value: string, limit = FIELD_LIMIT): string {
  return clipText(plainInline(value), limit);
}

function versionOf(record: JsonRecord, key: string): string {
  return `v${String(numberOf(record[key]) ?? 0)}`;
}

/* ───────────────────────── 条目 ───────────────────────── */

interface EntryShape {
  readonly kind: string;
  readonly id: string;
  readonly label: string;
  readonly fromTitle: boolean;
}

function entryShape(entry: JsonRecord): EntryShape {
  const title = textOf(entry["title"]);
  const intent = textOf(entry["intent"]);
  const label = clipText(plainInline(title ?? intent ?? ""), LABEL_LIMIT);
  return {
    kind: textOf(entry["kind"]) ?? "unknown",
    id: textOf(entry["id"]) ?? "?",
    label,
    fromTitle: title !== undefined && label !== "",
  };
}

function entryDetails(
  entry: JsonRecord,
  fromTitle: boolean,
  ctx: RenderContext,
): readonly string[] {
  const lines: string[] = [];
  const intent = textOf(entry["intent"]);
  if (fromTitle && intent !== undefined) lines.push(`  intent: ${inline(intent)}`);
  const action = textOf(entry["action"]);
  if (action !== undefined) lines.push(`  action: ${inline(action)}`);
  const payload = entry["payload"];
  if (payload !== undefined && payload !== null) {
    const rendered = formatPayload(payload, FIELD_LIMIT);
    if (rendered !== "" && rendered !== "none") lines.push(`  payload: ${rendered}`);
  }
  const window = textOf(entry["window"]);
  if (window !== undefined) lines.push(`  window: ${inline(window)}`);
  const doneWhen = textOf(entry["done_when"]);
  if (doneWhen !== undefined) lines.push(`  done_when: ${inline(doneWhen)}`);
  const targetDate = textOf(entry["target_date"]);
  if (targetDate !== undefined) lines.push(`  target_date: ${targetDate}`);
  const checkpointId = textOf(entry["checkpoint_id"]);
  if (checkpointId !== undefined) lines.push(`  checkpoint_id: ${checkpointId}`);
  const notDo = stringsOf(entry["not_do"])
    .map((item) => plainInline(item))
    .filter((item) => item !== "");
  if (notDo.length > 0) lines.push(`  not_do: ${notDo.join("; ")}`);
  const note = textOf(entry["note"]);
  if (note !== undefined) lines.push(`  note: ${inline(note)}`);
  const instruction = textOf(entry["instruction"]);
  if (instruction !== undefined && ctx.include(textOf(entry["id"]) ?? "?")) {
    lines.push(`  instruction: ${plainInline(instruction)}`);
  }
  return lines;
}

interface PlanEntryStyle {
  readonly prefix?: string;
  readonly sourceFallback?: string;
}

function renderPlanEntry(
  entry: JsonRecord,
  ctx: RenderContext,
  style: PlanEntryStyle = {},
): readonly string[] {
  const shape = entryShape(entry);
  const at = textOf(entry["at"]) ?? "--";
  const status = textOf(entry["status"]) ?? "unknown";
  const source = textOf(entry["source"]) ?? style.sourceFallback ?? "overlay";
  let line = `${style.prefix ?? "- "}[${at}] ${shape.kind} ${shape.id}`;
  if (shape.label !== "") line += ` ${shape.label}`;
  line += ` status=${status} source=${source}`;
  if (entry["suppressed"] === true) line += " suppressed=true";
  const evidence = textOf(entry["evidence"]);
  if (evidence !== undefined) {
    line += ` evidence=${clipText(plainInline(evidence), EVIDENCE_LIMIT)}`;
  }
  const doneAt = textOf(entry["done_at"]);
  if (doneAt !== undefined) line += ` done_at=${doneAt}`;
  return [line, ...entryDetails(entry, shape.fromTitle, ctx)];
}

/** 母版条目：括号用排班形状，禁用项补 enabled=false。 */
function renderMasterEntry(entry: JsonRecord, ctx: RenderContext): readonly string[] {
  const shape = entryShape(entry);
  const schedule = recordOf(entry["schedule"]);
  const scheduleKind = textOf(schedule["kind"]) ?? "?";
  const scheduleAt = textOf(schedule["at"]) ?? "--";
  const status = textOf(entry["status"]) ?? "active";
  let line = `- [${scheduleKind}@${scheduleAt}] ${shape.kind} ${shape.id}`;
  if (shape.label !== "") line += ` ${shape.label}`;
  line += ` status=${status} source=master`;
  if (entry["enabled"] === false) line += " enabled=false";
  return [line, ...entryDetails(entry, shape.fromTitle, ctx)];
}

/* ───────────────────────── 公共块 ───────────────────────── */

function entriesCountLine(entries: readonly JsonRecord[]): string {
  const counts = countBy(entries, (entry) => textOf(entry["status"]) ?? "unknown");
  return `entries ${String(entries.length)} (${counts})`;
}

/* ───────────────────────── 过滤 ───────────────────────── */

interface EntryFilterSpec {
  readonly status: readonly string[];
  readonly kind: readonly string[];
  readonly suffix: string;
}

function filterSpecOf(filter?: PlanEntryFilter): EntryFilterSpec | undefined {
  const status = stringsOf(filter?.status);
  const kind = stringsOf(filter?.kind);
  if (status.length === 0 && kind.length === 0) return undefined;
  const parts: string[] = [];
  if (status.length > 0) parts.push(`status=${status.join("|")}`);
  if (kind.length > 0) parts.push(`kind=${kind.join("|")}`);
  return { status, kind, suffix: `filter=${parts.join(",")}` };
}

function entryStatusOf(entry: JsonRecord): string {
  return textOf(entry["status"]) ?? "unknown";
}

function masterStatusOf(entry: JsonRecord): string {
  if (entry["enabled"] === false) return "archived";
  return textOf(entry["status"]) ?? "planned";
}

function normalizeKind(value: string): string {
  return value === "anchor" ? "coverage" : value;
}

function matchesFilter(
  entry: JsonRecord,
  spec: EntryFilterSpec,
  statusOf: (entry: JsonRecord) => string,
): boolean {
  if (spec.status.length > 0 && !spec.status.includes(statusOf(entry))) return false;
  if (spec.kind.length > 0) {
    const kind = normalizeKind(textOf(entry["kind"]) ?? "unknown");
    if (!spec.kind.some((value) => normalizeKind(value) === kind)) return false;
  }
  return true;
}

function filterEntries(
  entries: readonly JsonRecord[],
  spec: EntryFilterSpec | undefined,
  statusOf: (entry: JsonRecord) => string,
): readonly JsonRecord[] {
  if (spec === undefined) return entries;
  return entries.filter((entry) => matchesFilter(entry, spec, statusOf));
}

function filteredCountLine(
  label: "entries" | "items",
  shown: readonly JsonRecord[],
  total: number,
  spec: EntryFilterSpec,
  statusOf: (entry: JsonRecord) => string,
): string {
  const counts = countBy(shown, statusOf);
  return `${label} ${String(shown.length)}/${String(total)} (${counts}) ${spec.suffix}`;
}

function userIntentLine(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const intent = textOf(value);
    if (intent !== undefined) {
      return `user_intent: ${clipText(plainInline(intent), SUMMARY_LIMIT)}`;
    }
  }
  return undefined;
}

function renderCoverageLine(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const profile = textOf(value["profile"]);
  if (profile === undefined) return undefined;
  return `coverage ${formatCoverage({
    profile,
    checkpoints: stringsOf(value["checkpoints"]),
    debt: stringsOf(value["debt"]),
  })}`;
}

function renderNotes(notes: readonly string[]): readonly string[] {
  if (notes.length === 0) return [];
  const shown = notes.slice(0, NOTES_LIMIT);
  const lines = [
    `notes ${String(notes.length)}:`,
    ...shown.map((note) => `- ${plainInline(note)}`),
  ];
  if (notes.length > shown.length) lines.push(`…(+${String(notes.length - shown.length)})`);
  return lines;
}

function renderWarnings(warnings: readonly string[]): readonly string[] {
  if (warnings.length === 0) return [];
  return [`warnings: ${warnings.map((warning) => plainInline(warning)).join("; ")}`];
}

function renderLeftovers(
  leftovers: readonly JsonRecord[],
  ctx: RenderContext,
): readonly string[] {
  if (leftovers.length === 0) return [];
  const date = textOf(leftovers[0]?.["source_date"]) ?? "unknown";
  const lines = [`leftovers ${date}: ${String(leftovers.length)}`];
  for (const leftover of leftovers) {
    lines.push(...renderPlanEntry(leftover, ctx, { sourceFallback: "leftover" }));
  }
  return lines;
}

function renderOps(ops: readonly unknown[]): readonly string[] {
  const shown = ops.slice(0, OPS_LIMIT);
  const lines = [`ops ${String(ops.length)}:`];
  for (const op of shown) lines.push(`- ${formatPayload(op, FIELD_LIMIT)}`);
  if (ops.length > shown.length) lines.push(`…(+${String(ops.length - shown.length)})`);
  return lines;
}

function ledgerBody(row: JsonRecord): string {
  const at = numberOf(row["at"]);
  const clock =
    at === undefined || Math.abs(at) > MAX_EPOCH_MS
      ? "--:--"
      : `${new Date(at).toISOString().slice(11, 16)}Z`;
  const event = textOf(row["event"]) ?? "?";
  let line = `${clock} ${event}`;
  const version = numberOf(row["version"]);
  if (version !== undefined) line += ` v${String(version)}`;
  const reason = textOf(row["reason"]);
  if (reason !== undefined) {
    line += ` · ${clipText(plainInline(reason), LEDGER_REASON_LIMIT)}`;
  }
  return line;
}

function renderLedgerRow(row: JsonRecord): string {
  return `- ${ledgerBody(row)}`;
}

function renderLedgerLine(row: JsonRecord): string {
  return `ledger: ${ledgerBody(row)}`;
}

/* ───────────────────────── 七个动作 ───────────────────────── */

function renderRead(
  payload: JsonRecord,
  ctx: RenderContext,
  spec?: EntryFilterSpec,
): string {
  const date = textOf(payload["date"]) ?? "?";
  const master = recordOf(payload["master"]);
  const overlay = isRecord(payload["overlay"]) ? payload["overlay"] : null;
  const effective = isRecord(payload["effective"]) ? payload["effective"] : null;
  const lines: string[] = [];

  if (effective !== null) {
    const overlayVersion = overlay === null ? "none" : versionOf(overlay, "version");
    lines.push(
      `plan read ${date} master=${versionOf(master, "version")} overlay=${overlayVersion} ` +
        `status=${textOf(effective["status"]) ?? "unknown"} ` +
        `origin=${textOf(effective["origin"]) ?? "unknown"}`,
    );
    const coverageLine = renderCoverageLine(effective["coverage"]);
    if (coverageLine !== undefined) lines.push(coverageLine);
    const intentLine = userIntentLine(effective["user_intent"], overlay?.["user_intent"]);
    if (intentLine !== undefined) lines.push(intentLine);
    const entries = entriesOf(effective["entries"]);
    const shown = filterEntries(entries, spec, entryStatusOf);
    lines.push(
      spec === undefined
        ? entriesCountLine(entries)
        : filteredCountLine("entries", shown, entries.length, spec, entryStatusOf),
    );
    for (const entry of shown) lines.push(...renderPlanEntry(entry, ctx));
    lines.push(...renderWarnings(stringsOf(effective["warnings"])));
    lines.push(...renderNotes(stringsOf(effective["notes"])));
  } else {
    const entries = entriesOf(master["entries"]);
    const shown = filterEntries(entries, spec, masterStatusOf);
    lines.push(
      `plan read ${date} master=${versionOf(master, "version")} overlay=none effective=none`,
    );
    if (spec === undefined) {
      lines.push(`entries ${String(entries.length)} (master preview, no daily overlay)`);
    } else {
      lines.push(
        `${filteredCountLine("entries", shown, entries.length, spec, masterStatusOf)} ` +
          `(master preview, no daily overlay)`,
      );
    }
    for (const entry of shown) lines.push(...renderMasterEntry(entry, ctx));
  }

  lines.push(...renderLeftovers(entriesOf(payload["leftovers"]), ctx));
  const ledgerTail = entriesOf(payload["ledger_tail"]);
  if (ledgerTail.length > 0) {
    lines.push(`ledger tail ${String(ledgerTail.length)}:`);
    for (const row of ledgerTail) lines.push(renderLedgerRow(row));
  }
  return lines.join("\n");
}

function renderBase(
  payload: JsonRecord,
  ctx: RenderContext,
  spec?: EntryFilterSpec,
): string {
  const date = textOf(payload["date"]) ?? "?";
  const items = entriesOf(payload["items"]);
  const shown = filterEntries(items, spec, masterStatusOf);
  const header =
    spec === undefined
      ? `plan base ${date} master=${versionOf(payload, "master_version")} ` +
        `base=${versionOf(payload, "base_version")} items=${String(items.length)}`
      : `plan base ${date} master=${versionOf(payload, "master_version")} ` +
        `base=${versionOf(payload, "base_version")} items=${String(shown.length)}/${String(items.length)}`;
  const lines = [
    header,
    spec === undefined
      ? `items ${String(items.length)}:`
      : filteredCountLine("items", shown, items.length, spec, masterStatusOf),
  ];
  for (const item of shown) lines.push(...renderMasterEntry(item, ctx));
  lines.push(...renderLeftovers(entriesOf(payload["leftovers"]), ctx));
  return lines.join("\n");
}

function renderDiffLike(
  action: "diff" | "revise",
  payload: JsonRecord,
  _ctx: RenderContext,
): string {
  const date = textOf(payload["date"]) ?? "?";
  const overlay = recordOf(payload["overlay"]);
  const effective = recordOf(payload["effective"]);
  const lines = [
    `plan ${action} ${date} overlay=${versionOf(overlay, "version")} ` +
      `status=${textOf(overlay["status"]) ?? "unknown"} ` +
      `base=${versionOf(overlay, "base_version")}`,
  ];
  const coverageLine = renderCoverageLine(effective["coverage"] ?? overlay["coverage"]);
  if (coverageLine !== undefined) lines.push(coverageLine);
  const intentLine = userIntentLine(effective["user_intent"], overlay["user_intent"]);
  if (intentLine !== undefined) lines.push(intentLine);
  lines.push(...renderOps(valuesOf(overlay["ops"])));
  lines.push(entriesCountLine(entriesOf(effective["entries"])));
  lines.push(renderLedgerLine(recordOf(payload["ledger"])));
  return lines.join("\n");
}

function renderNote(payload: JsonRecord, _ctx: RenderContext): string {
  const date = textOf(payload["date"]) ?? "?";
  const overlay = recordOf(payload["overlay"]);
  const effective = recordOf(payload["effective"]);
  const notes = stringsOf(overlay["notes"]);
  const lines = [
    `plan note ${date} overlay=${versionOf(overlay, "version")} ` +
      `status=${textOf(overlay["status"]) ?? "unknown"} notes=${String(notes.length)}`,
  ];
  const latest = notes[notes.length - 1];
  if (latest !== undefined) lines.push(`latest note: ${inline(latest)}`);
  lines.push(entriesCountLine(entriesOf(effective["entries"])));
  lines.push(renderLedgerLine(recordOf(payload["ledger"])));
  return lines.join("\n");
}

function renderDone(payload: JsonRecord, ctx: RenderContext): string {
  const date = textOf(payload["date"]) ?? "?";
  const id = textOf(payload["id"]) ?? "?";
  const result = textOf(payload["status"]) ?? "unknown";
  const overlay = recordOf(payload["overlay"]);
  const effective = recordOf(payload["effective"]);
  const entries = entriesOf(effective["entries"]);
  const lines = [
    `plan done ${date} id=${id} result=${result} overlay=${versionOf(overlay, "version")} ` +
      `overlay_status=${textOf(overlay["status"]) ?? "unknown"}`,
  ];
  const changed = entries.find((entry) => entry["id"] === id);
  if (changed !== undefined) {
    const rendered = renderPlanEntry(changed, ctx, { prefix: "" });
    const head = rendered[0];
    if (head !== undefined) lines.push(`entry: ${head}`);
    lines.push(...rendered.slice(1));
  }
  lines.push(entriesCountLine(entries));
  lines.push(renderLedgerLine(recordOf(payload["ledger"])));
  return lines.join("\n");
}

function renderClose(payload: JsonRecord, ctx: RenderContext): string {
  const date = textOf(payload["date"]) ?? "?";
  const overlay = recordOf(payload["overlay"]);
  const effective = recordOf(payload["effective"]);
  const ledger = recordOf(payload["ledger"]);
  const notes = stringsOf(overlay["notes"]);
  const lines = [`plan close ${date} overlay=${versionOf(overlay, "version")} status=closed`];
  const summary = textOf(ledger["reason"]) ?? notes[notes.length - 1];
  if (summary !== undefined) lines.push(`summary: ${inline(summary, SUMMARY_LIMIT)}`);
  const carried = entriesOf(payload["carried"]);
  lines.push(`carried ${String(carried.length)}:`);
  for (const entry of carried) lines.push(...renderPlanEntry(entry, ctx));
  lines.push(entriesCountLine(entriesOf(effective["entries"])));
  lines.push(renderLedgerLine(ledger));
  return lines.join("\n");
}

const RENDERERS: Readonly<
  Record<
    PlanOverlayToolAction,
    (payload: JsonRecord, ctx: RenderContext, spec?: EntryFilterSpec) => string
  >
> = {
  read: renderRead,
  base: renderBase,
  diff: (payload, ctx) => renderDiffLike("diff", payload, ctx),
  revise: (payload, ctx) => renderDiffLike("revise", payload, ctx),
  note: renderNote,
  done: renderDone,
  close: renderClose,
};

/** 入口：action 决定头部形状，payload 与 details.__plan 同源。 */
export function renderPlanOverlayText(
  action: PlanOverlayToolAction,
  payload: unknown,
  options?: PlanOverlayRenderOptions,
): string {
  const scoped = action === "read" || action === "base";
  const ctx = scoped ? buildRenderContext(options) : HIDDEN_INSTRUCTION;
  const spec = scoped ? filterSpecOf(options?.filter) : undefined;
  return RENDERERS[action](recordOf(payload), ctx, spec);
}
