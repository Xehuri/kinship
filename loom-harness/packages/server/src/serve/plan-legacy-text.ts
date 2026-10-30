/**
 * 非 overlay 部署的 plan 工具文本投影：把结构化结果压成紧凑纯文本。
 *
 * 只影响 content[].text；details.__plan 仍保留完整结构（UI/测试按结构取数）。
 * 文本形状与 overlay plan 的纯文本口径一致，避免 fallback 部署重新把 JSON
 * 塞回模型上下文。
 */

import type {
  PlanCloseResult,
  PlanCoverage,
  PlanDocument,
  PlanItem,
} from "../plan/plan-store.js";

import type { PlanToolAction } from "./plan-tool.js";
import { clipText, countBy, formatCoverage, plainInline } from "./text-utils.js";

const INTENT_LIMIT = 80;
const SUMMARY_LIMIT = 300;
const NOTES_LIMIT = 10;

export function renderPlanLegacyText(
  action: PlanToolAction,
  payload: PlanDocument | PlanCloseResult,
): string {
  if (action === "close") {
    if (!isCloseResult(payload)) {
      throw new Error("renderPlanLegacyText: close 动作必须携带 PlanCloseResult");
    }
    return renderCloseResult(payload);
  }
  if (isCloseResult(payload)) {
    throw new Error("renderPlanLegacyText: 只有 close 动作携带 PlanCloseResult");
  }
  return renderPlanDocument(payload);
}

function isCloseResult(
  payload: PlanDocument | PlanCloseResult,
): payload is PlanCloseResult {
  return "plan" in payload;
}

function renderPlanDocument(doc: PlanDocument): string {
  return [
    `plan ${doc.date} status=${doc.status} v${String(doc.version)} review_at=${doc.review_at}`,
    renderCoverageLine(doc.coverage),
    ...renderItems(doc.items),
    ...renderNotes(doc.notes),
  ].join("\n");
}

function renderCloseResult(result: PlanCloseResult): string {
  const plan = result.plan;
  return [
    `plan ${plan.date} closed v${String(plan.version)} review_at=${plan.review_at}`,
    `summary: ${clipText(plainInline(result.summary), SUMMARY_LIMIT)}`,
    renderCoverageLine(plan.coverage),
    `carried ${String(result.carried.length)}: ${renderCarried(result.carried)}`,
    ...renderItems(plan.items),
    ...renderNotes(plan.notes),
  ].join("\n");
}

function renderCoverageLine(coverage: PlanCoverage): string {
  return `coverage ${formatCoverage(coverage)}`;
}

function renderItems(items: readonly PlanItem[]): readonly string[] {
  const lines = [
    `items ${String(items.length)} (${countBy(items, (item) => item.status)}):`,
  ];
  for (const item of items) {
    lines.push(
      `- ${item.id} ${item.kind} ` +
        `${clipText(plainInline(item.intent), INTENT_LIMIT)} status=${item.status}`,
    );
    lines.push(...renderItemFields(item));
  }
  return lines;
}

function renderItemFields(item: PlanItem): readonly string[] {
  const candidates: ReadonlyArray<string | null> = [
    fieldLine("target_date", item.target_date),
    fieldLine("window", item.window),
    fieldLine("checkpoint_id", item.checkpoint_id),
    fieldLine("done_when", item.done_when),
    notDoLine(item.not_do),
    fieldLine("source", item.source),
    fieldLine("note", item.note),
  ];
  return candidates.filter((line): line is string => line !== null);
}

function fieldLine(label: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  const text = plainInline(value);
  return text === "" ? null : `  ${label}: ${text}`;
}

function notDoLine(values: readonly string[] | undefined): string | null {
  if (values === undefined) return null;
  const text = values
    .map((value) => plainInline(value))
    .filter((value) => value !== "")
    .join("; ");
  return text === "" ? null : `  not_do: ${text}`;
}

function renderCarried(carried: readonly PlanItem[]): string {
  return carried.length === 0 ? "none" : carried.map((item) => item.id).join(", ");
}

function renderNotes(notes: readonly string[]): readonly string[] {
  if (notes.length === 0) return [];
  const shown = notes.slice(0, NOTES_LIMIT);
  const lines = [
    `notes ${String(notes.length)}:`,
    ...shown.map((note) => `- ${plainInline(note)}`),
  ];
  const hidden = notes.length - shown.length;
  if (hidden > 0) lines.push(`- …(+${String(hidden)})`);
  return lines;
}
