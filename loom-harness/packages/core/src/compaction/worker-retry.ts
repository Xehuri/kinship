/**
 * W57 压缩 worker 的 per-request 重试与请求生命周期。
 *
 * 一次 attempt 共用一个 P1 `CompactionRetryBudget`；每次 summarize 调用独立超时，
 * 超时/网络等 transient 才重试，重试复用**同一 messages 引用**。sleep 与请求都响应 abort。
 */

import type { Message } from "@earendil-works/pi-ai";
import type { HookContext } from "../hook.js";
import {
  CompactionRetryBudget,
  classifyCompactionError,
  retryDelayMs,
  type CompactionErrorClass,
} from "./compaction-retry.js";
import {
  COMPACTION_SUMMARY_MAX_CHARS,
  COMPACTION_SUMMARY_MIN_CHARS,
  CompactionAbortedError,
  CompactionRequestTimeoutError,
  CompactionSummaryValidationError,
  asRecord,
  toError,
} from "./worker-errors.js";
import type { SummarizeDelta, SummarizeFn } from "./worker-types.js";

export interface RetrySettings {
  readonly requestTimeoutMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
}

export interface RetryAttemptInfo {
  readonly retry: number;
  readonly delayMs: number;
  readonly errorClass: CompactionErrorClass;
  readonly error: Error;
}

export interface RetryHooks {
  readonly signal: AbortSignal;
  readonly abortReason: () => string | null;
  readonly onRetry: (info: RetryAttemptInfo) => void;
}

/** 从错误上读取 Retry-After（毫秒或秒），无则 null；最终仍受 P1 30s 硬顶。 */
function retryAfterMsOf(error: unknown): number | null {
  const record = asRecord(error);
  if (record === null) return null;
  const direct = record["retryAfterMs"];
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) return direct;
  const seconds = record["retryAfter"];
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const headers = asRecord(record["headers"]);
  const header = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (typeof header === "string" && /^\d+(?:\.\d+)?$/.test(header)) return Number(header) * 1000;
  return null;
}

export function throwIfAborted(signal: AbortSignal, abortReason: () => string | null): void {
  if (signal.aborted) throw new CompactionAbortedError(abortReason());
}

export function validateSummaryText(text: unknown): string {
  if (typeof text !== "string") {
    throw new CompactionSummaryValidationError("compaction summary is not a string");
  }
  const trimmed = text.trim();
  if (trimmed.length < COMPACTION_SUMMARY_MIN_CHARS) {
    throw new CompactionSummaryValidationError(
      `compaction summary is too short (${String(trimmed.length)} < ${String(COMPACTION_SUMMARY_MIN_CHARS)} chars)`,
    );
  }
  if (trimmed.length > COMPACTION_SUMMARY_MAX_CHARS) {
    throw new CompactionSummaryValidationError(
      `compaction summary is too long (${String(trimmed.length)} > ${String(COMPACTION_SUMMARY_MAX_CHARS)} chars)`,
    );
  }
  return trimmed;
}

/** P1 预算 + per-request 超时 + 可 abort sleep；重试复用同一 messages 引用。 */
export async function summarizeWithRetry(
  messages: Message[],
  ctx: HookContext,
  summarize: SummarizeFn,
  budget: CompactionRetryBudget,
  settings: RetrySettings,
  hooks: RetryHooks,
  onDelta?: (delta: SummarizeDelta) => void,
): Promise<string> {
  for (;;) {
    throwIfAborted(hooks.signal, hooks.abortReason);
    try {
      return await summarizeOnce(messages, ctx, summarize, settings, hooks, onDelta);
    } catch (error) {
      if (hooks.signal.aborted) throw new CompactionAbortedError(hooks.abortReason());
      const errorClass = classifyCompactionError(error);
      if (errorClass === "abort") throw error;
      if (errorClass !== "transient" || !budget.canRetry()) throw error;
      budget.consume();
      const retry = budget.used;
      const delayMs = retryDelayMs(retry - 1, retryAfterMsOf(error), settings.random);
      hooks.onRetry({ retry, delayMs, errorClass, error: toError(error) });
      await sleepAbortable(delayMs, settings.sleep, hooks.signal, hooks.abortReason);
    }
  }
}

function summarizeOnce(
  messages: Message[],
  ctx: HookContext,
  summarize: SummarizeFn,
  settings: RetrySettings,
  hooks: RetryHooks,
  onDelta?: (delta: SummarizeDelta) => void,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const guardedOnDelta =
      onDelta === undefined
        ? undefined
        : (delta: SummarizeDelta): void => {
            if (!settled) onDelta(delta);
          };
    const request = Promise.resolve().then(() => summarize(messages, ctx, guardedOnDelta));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      hooks.signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => {
      settle(() => reject(new CompactionAbortedError(hooks.abortReason())));
    };
    if (hooks.signal.aborted) {
      settle(() => reject(new CompactionAbortedError(hooks.abortReason())));
      return;
    }
    hooks.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      settle(() => reject(new CompactionRequestTimeoutError(settings.requestTimeoutMs)));
    }, settings.requestTimeoutMs);
    request.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

async function sleepAbortable(
  ms: number,
  sleep: (ms: number) => Promise<void>,
  signal: AbortSignal,
  abortReason: () => string | null,
): Promise<void> {
  if (signal.aborted) throw new CompactionAbortedError(abortReason());
  const sleeping = sleep(ms);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => {
      settle(() => reject(new CompactionAbortedError(abortReason())));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    sleeping.then(
      () => settle(resolve),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}
