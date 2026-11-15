/**
 * 统一唤醒队列的行渲染。
 *
 * 只做字符串拼装，不读盘、不排班、不发通知。条目来源决定使用哪条渲染器：
 *   - master / anchor / long_term -> 计划唤醒行；
 *   - flow -> 注入的 flow 渲染器（由调用方持有 FlowStore 快照）；
 *   - special -> 保留旧自动唤醒行；
 *   - 来源或动作无法识别 -> 按来源兜底动作，并回调告警。
 *
 * Ported from loom-harness/packages/server/src/plan/wake-render.ts (kinship@c945667).
 */

import {
  defaultActionFor,
  isWakeAction,
  isWakeSource,
  type WakeAction,
  type WakeSource,
} from "./actions.js";
import { addDays, zonedDateKey, zonedNow } from "./timezone.js";

/** 最小条目面；WakeQueue 后续直接复用这些字段。 */
export interface WakeEntry {
  readonly id: string;
  readonly title: string;
  readonly source: WakeSource | (string & {});
  readonly action?: WakeAction | (string & {});
  readonly at: number;
  readonly instructions?: string;
  readonly payload?: unknown;
}

export interface PlanWakeLineInput {
  readonly entry: WakeEntry;
  readonly date: string;
  readonly timezone: string;
  readonly instructions?: string;
}

export interface WakeRenderDeps {
  /** 缺省用 entry.at 在 timezone 的日期键。 */
  readonly date?: string;
  readonly timezone: string;
  readonly instructions?: string;
  readonly renderFlow?: (entry: WakeEntry, at: number) => string | null;
  readonly warn?: (message: string, entry: WakeEntry) => void;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function resolveSource(source: WakeEntry["source"]): WakeSource | null {
  return isWakeSource(source) ? source : null;
}

function resolveAction(
  entry: WakeEntry,
  source: WakeSource,
  warn: WakeRenderDeps["warn"],
): WakeAction {
  if (isWakeAction(entry.action)) return entry.action;
  if (entry.action !== undefined) {
    warn?.(`unknown wake action: ${String(entry.action)}`, entry);
  }
  return defaultActionFor(source, entry.id);
}

function normalizeEntry(
  entry: WakeEntry,
  source: WakeSource,
  action: WakeAction,
): WakeEntry {
  return {
    id: entry.id,
    title: entry.title,
    source,
    action,
    at: entry.at,
    ...(entry.instructions === undefined ? {} : { instructions: entry.instructions }),
    ...(entry.payload === undefined ? {} : { payload: entry.payload }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function planItemId(entry: WakeEntry): string {
  const payload = isRecord(entry.payload) ? entry.payload : null;
  const entryId = payload?.["entry_id"];
  if (typeof entryId === "string" && entryId !== "" && entryId !== "catchup") return entryId;
  return entry.id;
}

// dsh 适配：唤醒条目来自母版，v1 当日账里没有这些 id，plan done 会报 item-not-found。
function planDoneHint(entry: WakeEntry, _date: string): string {
  if (entry.action === "plan.build" || entry.action === "plan.review") {
    return "完成后只写当日计划，不需要 plan done。";
  }
  return "完成后用 plan note 记一行结论（母版条目不在当日 v1 账里，plan done 不适用）。";
}

function coverageInstruction(entry: WakeEntry, date: string): string | null {
  if (entry.action !== "coverage.run") return null;
  const payload = isRecord(entry.payload) ? entry.payload : null;
  const window = typeof payload?.["window"] === "string" ? payload["window"] : "?";
  const rawTarget = payload?.["target_date"];
  const target =
    rawTarget === "previous_day"
      ? addDays(date, -1)
      : typeof rawTarget === "string" && rawTarget !== "today"
        ? rawTarget
        : date;
  // dsh 适配：不再要求 coverage 完成后跑 plan done（母版条目不在当日 v1 账里，
  // 该指令会和下一行的 plan note 提示互相矛盾），留痕口径统一由 planDoneHint 给。
  return `按 data-check 流程执行 ${entry.title}（窗口 ${window}，目标日 ${target}）。`;
}

/**
 * 计划唤醒行：标题行固定为
 * `【计划唤醒·{action}】{HH:MM} · {title}`，正文带指令、条目 id、
 * plan done 提示与“不发用户通知”的边界。
 */
export function formatPlanWakeLine(input: PlanWakeLineInput): string {
  const source = resolveSource(input.entry.source) ?? "master";
  const action = isWakeAction(input.entry.action)
    ? input.entry.action
    : defaultActionFor(source, input.entry.id);
  const zoned = zonedNow(input.entry.at, input.timezone);
  const lines = [
    `【计划唤醒·${action}】${pad2(zoned.hour)}:${pad2(zoned.minute)} · ${input.entry.title}`,
  ];
  const instructions = (
    input.instructions ??
    input.entry.instructions ??
    coverageInstruction(input.entry, input.date) ??
    ""
  ).trim();
  if (instructions !== "") lines.push(instructions);
  lines.push(`条目：${planItemId(input.entry)}`);
  lines.push(planDoneHint(input.entry, input.date));
  lines.push("不发用户通知，除非条目要求。");
  return lines.join("\n");
}

/** 旧自动唤醒行的原样形状（文案与既有 formatAutoWakeLine 一致）。 */
export function formatSpecialWakeLine(at: number): string {
  return `【自动唤醒】设定的唤醒时间已到（${formatWakeAt(at)}，本地时间）。请继续处理此前挂起的任务。`;
}

/**
 * inbox 摘要的缺省行：正常生产由 boot 的 inbox digest renderer 覆盖；
 * 本分支只保证 renderWakeEntry 永不为 inbox 来源返回 null，且指令/载荷可被显式透传。
 */
export function formatInboxWakeLine(entry: WakeEntry): string {
  const instructions = entry.instructions?.trim();
  if (instructions !== undefined && instructions !== "") return instructions;
  const payload = isRecord(entry.payload) ? entry.payload : null;
  const title = typeof payload?.["title"] === "string" ? payload["title"] : "";
  const head = title !== "" ? `【收件箱摘要】${title}` : "【收件箱摘要】";
  return `${head}（${formatWakeAt(entry.at)}，本地时间）。请按收件箱流程处理待处理信件。`;
}

/** 按来源/动作分派渲染；无法识别时回落到来源兜底动作并告警。 */
export function renderWakeEntry(entry: WakeEntry, deps: WakeRenderDeps): string | null {
  const source = resolveSource(entry.source);
  if (source === null) {
    deps.warn?.(`unknown wake source: ${String(entry.source)}`, entry);
  }
  const effectiveSource = source ?? "master";
  const action = resolveAction(entry, effectiveSource, deps.warn);
  const normalized = normalizeEntry(entry, effectiveSource, action);

  if (source === "flow" || action === "flow.check") {
    if (deps.renderFlow === undefined) {
      deps.warn?.("flow wake entry has no flow renderer", entry);
      return null;
    }
    return deps.renderFlow(normalized, normalized.at) ?? null;
  }
  if (source === "special" || action === "special.continue") {
    return formatSpecialWakeLine(entry.at);
  }
  if (source === "inbox" || action === "inbox.digest") {
    return formatInboxWakeLine(normalized);
  }
  return formatPlanWakeLine({
    entry: normalized,
    date: deps.date ?? zonedDateKey(entry.at, deps.timezone),
    timezone: deps.timezone,
    ...(deps.instructions === undefined ? {} : { instructions: deps.instructions }),
  });
}

/** Local copy of loom-core's wake timestamp rendering; process-local clock. */
function formatWakeAt(at: number): string {
  const d = new Date(at);
  const year = String(d.getFullYear()).padStart(4, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const minute = String(d.getMinutes()).padStart(2, "0");
  const base = `${year}-${month}-${day} ${hour}:${minute}`;
  const second = d.getSeconds();
  return second === 0 ? base : `${base}:${String(second).padStart(2, "0")}`;
}
