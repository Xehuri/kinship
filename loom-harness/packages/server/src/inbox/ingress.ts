/**
 * 收件箱入口的响应映射（T3）：校验结果、403/413/429 响应体、Retry-After 与
 * policy 的公开 decision 面。纯函数/小工具，不碰投递原语。
 */

import type { ServerResponse } from "node:http";

import type { InboxSourceConfig } from "../config/section-checks.js";
import { sendJson } from "../http/index.js";
import type { InboxJournalStore } from "./journal-store.js";
import { LetterValidationError, validateLetterInput } from "./validate.js";
import type {
  InboxPolicyDecision,
  InboxPolicyReason,
  LetterClass,
  LetterInput,
  LetterTrust,
} from "./types.js";

export interface SuppressedResponse {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly retry_after_s?: number;
}

const RATE_REASONS: ReadonlySet<InboxPolicyReason> = new Set([
  "rate_limited",
  "burst_limited",
  "global_rate_limited",
  "cooldown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`unhandled inbox policy variant: ${String(value)}`);
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  sendJson(res, status, { error: { code, message }, ...extra });
}

export function suppressedResponse(reason: InboxPolicyReason): SuppressedResponse {
  switch (reason) {
    case "mode_off":
      return { status: 503, code: "inbox_disabled", message: "inbox is disabled (mode=off)" };
    case "source_unregistered":
      return { status: 403, code: "source_unregistered", message: "source is not registered" };
    case "source_max_trust":
    case "trust_ceiling":
      return { status: 403, code: "trust_ceiling", message: "requested trust exceeds source ceiling" };
    case "expired":
      return { status: 410, code: "letter_expired", message: "letter is already expired" };
    case "dedupe_key_required":
      return { status: 400, code: "dedupe_key_required", message: "source requires dedupe_key" };
    case "max_pending":
      return {
        status: 429,
        code: "inbox_full",
        message: "inbox pending limit reached",
        retry_after_s: 60,
      };
    case "rate_limited":
    case "burst_limited":
    case "global_rate_limited":
    case "cooldown":
      return {
        status: 429,
        code: "rate_limited",
        message: `source is rate limited (${reason})`,
        retry_after_s: 60,
      };
    case "source_max_class":
      return { status: 400, code: "source_max_class", message: "source class ceiling rejected the letter" };
    case "quiet_hours":
      return { status: 400, code: "quiet_hours", message: "source is in quiet hours" };
    case "notify_burst":
      return { status: 400, code: "notify_burst", message: "notify burst policy rejected the letter" };
    case "accepted":
    case "mode_shadow":
    case "duplicate":
    case "coalesced":
      return { status: 400, code: "inconsistent_policy", message: `unexpected suppression: ${reason}` };
    default:
      return assertNever(reason);
  }
}

export function rateLimitReason(decision: InboxPolicyDecision): InboxPolicyReason | undefined {
  for (const reason of decision.reasons) {
    if (RATE_REASONS.has(reason)) return reason;
  }
  return undefined;
}

export function retryAfterSeconds(
  reason: InboxPolicyReason,
  source: InboxSourceConfig,
  store: InboxJournalStore,
  sourceKey: string,
  now: number,
): number {
  switch (reason) {
    case "burst_limited":
      return 1;
    case "cooldown": {
      const cooldownMs = source.cooldownMs ?? 0;
      const last = store.rateWindow(sourceKey, now, Math.max(cooldownMs, 1)).last_at;
      if (last === null) return 1;
      return Math.max(1, Math.ceil((cooldownMs - (now - last)) / 1000));
    }
    case "rate_limited":
    case "global_rate_limited":
      return 60;
    default:
      return 1;
  }
}

export function publicDecision(decision: InboxPolicyDecision): Record<string, unknown> {
  return {
    class: decision.class,
    trust: decision.trust,
    route: decision.route,
    outcome: decision.outcome,
    reason: decision.reason,
    reasons: decision.reasons,
    ...(decision.dedupe === undefined ? {} : { dedupe: decision.dedupe }),
    ...(decision.coalesce === undefined ? {} : { coalesce: decision.coalesce }),
  };
}

export function recordSuppression(
  store: InboxJournalStore,
  input: LetterInput,
  trust: LetterTrust,
  letterClass: LetterClass,
  reason: InboxPolicyReason,
  now: number,
): void {
  store.append(input, {
    now,
    decision: {
      class: letterClass,
      trust,
      route: "suppressed",
      outcome: "suppressed",
      reason,
      reasons: [reason],
    },
  });
}

export function respondSuppressed(res: ServerResponse, reason: InboxPolicyReason): void {
  const mapped = suppressedResponse(reason);
  if (mapped.retry_after_s !== undefined) {
    res.setHeader("Retry-After", String(mapped.retry_after_s));
  }
  sendError(res, mapped.status, mapped.code, mapped.message);
}

function bodyTooLarge(raw: unknown, maxBodyBytes: number): number | null {
  if (!isRecord(raw) || typeof raw["body"] !== "string") return null;
  const bytes = Buffer.byteLength(raw["body"], "utf8");
  return bytes > maxBodyBytes ? bytes : null;
}

export function validateOrRespond(
  res: ServerResponse,
  raw: unknown,
  maxBodyBytes: number,
): LetterInput | null {
  const oversized = bodyTooLarge(raw, maxBodyBytes);
  if (oversized !== null) {
    sendError(res, 413, "letter_body_too_large", `body 超过 ${maxBodyBytes} 字节`, {
      field: "body",
      max_bytes: maxBodyBytes,
      actual_bytes: oversized,
    });
    return null;
  }
  try {
    return validateLetterInput(raw, { maxBodyBytes });
  } catch (error: unknown) {
    if (error instanceof LetterValidationError) {
      const tooLarge = error.errors.some(
        (item) => item.field === "body" && item.message.includes("字节数不得超过"),
      );
      if (tooLarge) {
        sendError(res, 413, "letter_body_too_large", `body 超过 ${maxBodyBytes} 字节`, {
          errors: error.errors,
        });
      } else {
        sendError(res, 400, "invalid_letter", "letter validation failed", {
          errors: error.errors,
        });
      }
      return null;
    }
    throw error;
  }
}
