/**
 * 回执 schema、收束语义类型与催办文案（docs/01 D23/D25/D26 冻结）。
 *
 * 收束工具的参数 = 回执结构；这是「终止会话」的唯一合法载荷。
 * parseReceiptArgs 是不可信模型输出进本模块的**唯一边界**：TypeBox schema 挡外层
 * 形状（必填缺失/枚举越界），这里再挡语义空壳（whitespace、非整数 attempt、
 * attempt<1）——两层都过才算「必填字段齐」。模型「字段全但内容空」的假收束死在这层。
 */

import type { Limits } from "./limits.js";
import { resolveWakeSpec } from "./wake.js";

export type SessionKind = "main" | "side";

export type MainStatus = "已完成" | "待用户回应" | "需用户确认";
export type SideStatus = "done" | "partial" | "failed";

export interface MainReceipt {
  status: MainStatus;
  digest: string;
  body?: string;
  pointers: string[];
  blockers: string[];
  nextWakeAt?: number | null;
}

export interface SideReceipt {
  status: SideStatus;
  runId: string;
  workflow: string;
  attempt: number;
  digest: string;
  pointers: string[];
  blockers: string[];
  nextWakeAt?: number | null;
}

export type Receipt = MainReceipt | SideReceipt;

export type NudgeReason = "fields" | "duplicate" | "text-only";
export type ForceReason = "nudge-limit" | "turn-hard-cap";

/**
 * 收束状态机的可见输出（判别联合）。消费方（T10/T12）必须 exhaustive switch。
 *
 * - converged:  收束工具成功调用且必填字段齐 —— 终止会话的唯一合法通道。
 * - nudged:     催办（fields/duplicate/text-only），带累计序号。
 * - escalated:  同工具同错误达阈值的升级提示（不终止会话）。
 * - forceEnded: 分级强制收束（催办上限/轮数硬顶），带**如实**合成回执；
 *               副会话 deadLetter=true（死信投主由 T12/T13 消费）。
 * - continued:  闸放行了下一轮（无新信息，仅记账）。
 */
export type ConvergenceOutcome =
  | { type: "converged"; status: MainStatus | SideStatus; receipt: Receipt }
  | { type: "nudged"; reason: NudgeReason; nudgeCount: number }
  | { type: "escalated"; tool: string; errorText: string; attempt: number }
  | {
      type: "forceEnded";
      reason: ForceReason;
      receipt: Receipt;
      deadLetter: boolean;
    }
  | { type: "continued"; nudgeCount: number };

export const NUDGE_MARK = "【收束催办】" as const;
export const ESCALATE_MARK = "【收束升级】" as const;
export const DEAD_LETTER_MARK = "【死信】" as const;
export const FORCE_MARK = "【强制收束】" as const;

const MAIN_STATUSES: readonly MainStatus[] = ["已完成", "待用户回应", "需用户确认"];
const SIDE_STATUSES: readonly SideStatus[] = ["done", "partial", "failed"];

function isMainStatus(v: unknown): v is MainStatus {
  return v === "已完成" || v === "待用户回应" || v === "需用户确认";
}

function isSideStatus(v: unknown): v is SideStatus {
  return v === "done" || v === "partial" || v === "failed";
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x): x is string => typeof x === "string");
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function stringArray(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!isStringArray(v)) return null;
  return [...v];
}

function firstNonEmpty(...values: ReadonlyArray<unknown>): string | null {
  for (const value of values) {
    if (isNonEmptyString(value)) return value;
  }
  return null;
}

export interface ReceiptParseOptions {
  readonly derivedDigest?: string;
  readonly now?: number;
  readonly autoWakeEnabled?: boolean;
}

interface WakeField {
  readonly present: boolean;
  readonly at: number | null;
}

function resolveWakeField(
  kind: SessionKind,
  args: Record<string, unknown>,
  opts: ReceiptParseOptions,
  missing: string[],
): WakeField {
  const raw = args["wake"];
  if (raw === undefined) return { present: false, at: null };
  if (kind !== "main") {
    missing.push("wake（仅主会话支持）");
    return { present: false, at: null };
  }
  if (opts.autoWakeEnabled === false) {
    missing.push("wake（自动唤醒已禁用）");
    return { present: false, at: null };
  }
  if (typeof raw !== "string") {
    missing.push("wake（须为字符串）");
    return { present: false, at: null };
  }
  const resolved = resolveWakeSpec(raw, opts.now ?? Date.now());
  if (!resolved.ok) {
    missing.push(`wake（${resolved.reason}）`);
    return { present: false, at: null };
  }
  return { present: true, at: resolved.at };
}

export type ParseResult =
  | { ok: true; receipt: Receipt }
  | { ok: false; missing: string[] };

/** 边界解析：不可信 args → 类型化 Receipt（或列明缺失/非法字段）。纯函数。 */
export function parseReceiptArgs(
  kind: SessionKind,
  args: Record<string, unknown>,
  opts: ReceiptParseOptions = {},
): ParseResult {
  const missing: string[] = [];

  const pointers = stringArray(args["pointers"]);
  if (pointers === null) missing.push("pointers（须为字符串数组）");
  const blockers = stringArray(args["blockers"]);
  if (blockers === null) missing.push("blockers（须为字符串数组）");
  const wake = resolveWakeField(kind, args, opts, missing);

  if (kind === "main") {
    const status = args["status"];
    if (!isMainStatus(status)) {
      missing.push(`status（须∈{${MAIN_STATUSES.join(",")}}）`);
    }
    const digest = firstNonEmpty(args["digest"], opts.derivedDigest);
    if (digest === null) missing.push("digest（须非空白）");
    const rawBody = args["body"];
    const body = isNonEmptyString(rawBody) ? rawBody : null;
    if (
      missing.length > 0 ||
      pointers === null ||
      blockers === null ||
      !isMainStatus(status) ||
      digest === null
    ) {
      return { ok: false, missing };
    }
    return {
      ok: true,
      receipt: {
        status,
        digest,
        ...(body === null ? {} : { body }),
        pointers,
        blockers,
        ...(wake.present ? { nextWakeAt: wake.at } : {}),
      },
    };
  }

  const status = args["status"];
  if (!isSideStatus(status)) {
    missing.push(`status（须∈{${SIDE_STATUSES.join(",")}}）`);
  }
  const runId = args["runId"];
  const workflow = args["workflow"];
  const digest = firstNonEmpty(args["digest"], opts.derivedDigest);
  const attempt = args["attempt"];
  if (!isNonEmptyString(runId)) missing.push("runId（须非空白）");
  if (!isNonEmptyString(workflow)) missing.push("workflow（须非空白）");
  if (digest === null) missing.push("digest（须非空白）");
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) {
    missing.push("attempt（须为 ≥1 整数）");
  }
  if (
    missing.length > 0 ||
    pointers === null ||
    blockers === null ||
    !isSideStatus(status) ||
    !isNonEmptyString(runId) ||
    !isNonEmptyString(workflow) ||
    digest === null ||
    typeof attempt !== "number"
  ) {
    return { ok: false, missing };
  }
  return {
    ok: true,
    receipt: { status, runId, workflow, attempt, digest, pointers, blockers },
  };
}

/** 仅当 nextWakeAt 键存在时返回其值（undefined = 本回执未携带唤醒信息）。 */
export function nextWakeAtOf(receipt: Receipt): number | null | undefined {
  return "nextWakeAt" in receipt ? receipt.nextWakeAt : undefined;
}

/** 分级强制收束的合成回执（D26：如实说明卡点，绝不静默假完成）。纯函数。 */
export function makeForceReceipt(
  kind: SessionKind,
  reason: ForceReason,
  limits: Limits,
): Receipt {
  const cause = reason === "turn-hard-cap" ? "轮数硬顶" : "催办上限";
  const detail =
    reason === "turn-hard-cap"
      ? `轮数硬顶 ${limits.turnHardCap}，会话未自行收束，已由 harness 强制收束`
      : `连续 ${limits.nudgeLimit} 次催办未收敛，已由 harness 强制收束`;
  const digest =
    kind === "main"
      ? `需用户确认：触发${cause}——${detail}`
      : `failed：触发${cause}——${detail}`;
  if (kind === "main") {
    return {
      status: "需用户确认",
      digest,
      body: `${detail}。模型未给出合法收束回执（缺字段或纯文本空转），请用户确认后续处置。`,
      pointers: [],
      blockers: [cause],
    };
  }
  return {
    status: "failed",
    runId: "unknown",
    workflow: "unknown",
    attempt: 0,
    digest,
    pointers: [],
    blockers: [cause],
  };
}

/** 催办文案：带标记与 n/limit 进度。纯函数，各注入通道共用。 */
export function nudgeText(
  reason: NudgeReason,
  detail: string,
  count: number,
  limit: number,
): string {
  const head = `${NUDGE_MARK}${count}/${limit}`;
  switch (reason) {
    case "fields":
      return `${head} 收束回执必填字段不齐，会话未结束。缺失/非法：${detail}`;
    case "duplicate":
      return `${head} 本轮已受理过一次收束，重复收束调用不计数、不生效。明细：${detail}`;
    case "text-only":
      return `${head} 纯文本不会结束会话。请在正文所在的同一轮调用 converge，给出必填字段齐全的回执。明细：${detail}`;
    default: {
      const unreachable: never = reason;
      throw new Error(`unhandled NudgeReason: ${String(unreachable)}`);
    }
  }
}

export function receiptStatusOf(receipt: Receipt): string {
  return receipt.status;
}
