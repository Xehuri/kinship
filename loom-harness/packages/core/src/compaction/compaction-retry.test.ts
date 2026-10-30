/**
 * W57 压缩重试单测：10 次预算、退避/Retry-After 硬顶、抖动范围与错误分类。
 */

import { describe, expect, it } from "vitest";
import {
  COMPACTION_MAX_RETRIES,
  COMPACTION_RETRY_BASE_MS,
  COMPACTION_RETRY_MAX_DELAY_MS,
  CompactionRetryBudget,
  classifyCompactionError,
  retryDelayMs,
} from "./compaction-retry.js";

describe("CompactionRetryBudget", () => {
  it("allows exactly 10 retries (11 total attempts) by default", () => {
    expect(COMPACTION_MAX_RETRIES).toBe(10);
    const budget = new CompactionRetryBudget();
    expect(budget.remaining).toBe(10);

    for (let retry = 1; retry <= COMPACTION_MAX_RETRIES; retry++) {
      expect(budget.canRetry()).toBe(true);
      expect(budget.consume()).toBe(true);
      expect(budget.remaining).toBe(COMPACTION_MAX_RETRIES - retry);
    }

    expect(budget.canRetry()).toBe(false);
    expect(budget.consume()).toBe(false);
    expect(budget.used).toBe(COMPACTION_MAX_RETRIES);
    expect(budget.remaining).toBe(0);
  });

  it("accepts a per-instance limit and rejects invalid limits", () => {
    const budget = new CompactionRetryBudget({ maxRetries: 2 });
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(false);
    expect(budget.remaining).toBe(0);

    expect(() => new CompactionRetryBudget({ maxRetries: -1 })).toThrow(RangeError);
    expect(() => new CompactionRetryBudget({ maxRetries: 1.5 })).toThrow(RangeError);
  });
});

describe("retryDelayMs", () => {
  it("uses 2s base, doubles per attempt, and caps at 30s", () => {
    expect(retryDelayMs(0, undefined, () => 0.5)).toBe(COMPACTION_RETRY_BASE_MS);
    expect(retryDelayMs(1, undefined, () => 0.5)).toBe(4_000);
    expect(retryDelayMs(2, undefined, () => 0.5)).toBe(8_000);
    expect(retryDelayMs(4, undefined, () => 0.5)).toBe(COMPACTION_RETRY_MAX_DELAY_MS);
    expect(retryDelayMs(50, undefined, () => 0.5)).toBe(COMPACTION_RETRY_MAX_DELAY_MS);
  });

  it("keeps jitter inside 25% of the exponential base", () => {
    expect(retryDelayMs(3, undefined, () => 0)).toBe(12_000);
    expect(retryDelayMs(3, undefined, () => 1)).toBe(20_000);
    expect(retryDelayMs(3, undefined, () => 0.5)).toBe(16_000);
    for (let attempt = 0; attempt < 12; attempt++) {
      for (const sample of [0, 0.1, 0.5, 0.9, 1]) {
        const delay = retryDelayMs(attempt, undefined, () => sample);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(COMPACTION_RETRY_MAX_DELAY_MS);
      }
    }
  });

  it("honors Retry-After but still caps it at 30s", () => {
    expect(retryDelayMs(0, 5_000, () => 0.5)).toBe(5_000);
    expect(retryDelayMs(0, 120_000, () => 0.5)).toBe(COMPACTION_RETRY_MAX_DELAY_MS);
    expect(retryDelayMs(9, 1_000, () => 0.5)).toBe(1_000);
  });

  it("rejects invalid attempt numbers", () => {
    expect(() => retryDelayMs(-1)).toThrow(RangeError);
    expect(() => retryDelayMs(1.2)).toThrow(RangeError);
  });
});

describe("classifyCompactionError", () => {
  it("marks overflow/length as non-retryable overflow", () => {
    expect(classifyCompactionError({ stopReason: "length" })).toBe("overflow");
    expect(
      classifyCompactionError(new Error("This model's maximum context length is 128000 tokens")),
    ).toBe("overflow");
    expect(
      classifyCompactionError(new Error("Range of input length should be [1, 1000000]")),
    ).toBe("overflow");
    expect(classifyCompactionError({ kind: "overflow" })).toBe("overflow");
  });

  it("marks synchronous stream-creation failures as sync", () => {
    expect(classifyCompactionError({ phase: "stream_create", message: "boom" })).toBe("sync");
    expect(
      classifyCompactionError(Object.assign(new Error("cannot open stream"), { name: "StreamCreationError" })),
    ).toBe("sync");
    expect(classifyCompactionError({ code: "STREAM_CREATION_ERROR" })).toBe("sync");
  });

  it("marks true user aborts as abort", () => {
    expect(
      classifyCompactionError(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
    ).toBe("abort");
    expect(classifyCompactionError({ code: "ABORT_ERR", message: "aborted" })).toBe("abort");
    expect(classifyCompactionError(new Error("request aborted by user"))).toBe("abort");
  });

  it("distinguishes peer/network aborts from user aborts", () => {
    expect(classifyCompactionError({ name: "Error", message: "connection aborted" })).toBe("transient");
    expect(classifyCompactionError({ message: "request aborted by peer" })).toBe("transient");
    expect(classifyCompactionError({ name: "AbortError", message: "This operation was aborted" })).toBe("abort");
    expect(classifyCompactionError({ message: "aborted by user" })).toBe("abort");
    const generic = { message: "The operation was aborted" };
    expect(classifyCompactionError(generic)).toBe("terminal");
  });

  it("classifies rate limits, 5xx, network and timeout errors as transient", () => {
    expect(classifyCompactionError(new Error("429 Too Many Requests: rate limit exceeded"))).toBe("transient");
    expect(classifyCompactionError({ status: 503, message: "upstream failed" })).toBe("transient");
    expect(classifyCompactionError({ response: { status: 502 }, message: "bad gateway" })).toBe("transient");
    expect(classifyCompactionError({ code: "ECONNRESET" })).toBe("transient");
    expect(classifyCompactionError(new Error("request timed out after 300s"))).toBe("transient");
    expect(
      classifyCompactionError(Object.assign(new Error("This operation was aborted"), { name: "TimeoutError" })),
    ).toBe("transient");
    expect(classifyCompactionError({ kind: "rate_limit", message: "slow down" })).toBe("transient");
  });

  it("treats truncated summary streams as transient", () => {
    expect(
      classifyCompactionError(new Error("streamText failed (stopReason=error): Stream ended without finish_reason")),
    ).toBe("transient");
    expect(classifyCompactionError(new Error("Stream ended without finish_reason"))).toBe("transient");
    expect(classifyCompactionError(new Error("unexpected end of stream"))).toBe("transient");
    expect(classifyCompactionError(new Error("unexpected end of response"))).toBe("transient");
    expect(classifyCompactionError(new Error("stream closed before finish"))).toBe("transient");
    expect(classifyCompactionError(new Error("stream ended before finish"))).toBe("transient");
    expect(classifyCompactionError(new Error("stream terminated before finish"))).toBe("transient");

    expect(classifyCompactionError(new Error("streamText failed (stopReason=error): invalid api key"))).toBe(
      "terminal",
    );
    expect(classifyCompactionError(new Error("streamText failed (stopReason=error)"))).toBe("terminal");
  });

  it("treats auth/config/unknown errors as terminal", () => {
    expect(classifyCompactionError({ status: 401, message: "invalid api key" })).toBe("terminal");
    expect(classifyCompactionError({ status: 400, message: "invalid request" })).toBe("terminal");
    expect(classifyCompactionError(new Error("tool schema is malformed"))).toBe("terminal");
    expect(classifyCompactionError(undefined)).toBe("terminal");
  });
});
