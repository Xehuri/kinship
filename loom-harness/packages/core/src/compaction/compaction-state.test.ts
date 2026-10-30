/**
 * W57 压缩状态机单测：迁移图、suppression、boot retry 与边界校验。
 * 只测纯函数；sidecar/重试分别见同目录另两个测试文件。
 */

import { describe, expect, it } from "vitest";
import {
  COMPACTION_STATE_VERSION,
  beginCompaction,
  clearFallbackSuppression,
  idleState,
  isCompactionState,
  markBootRetryConsumed,
  markCompactionAborted,
  markCompactionFailure,
  markCompactionSuccess,
  suppressFallback,
} from "./compaction-state.js";

describe("compaction-state transitions", () => {
  it("idle -> compacting -> idle on success", () => {
    const idle = idleState(1_000);
    const running = beginCompaction(idle, {
      attemptId: "cmp_1",
      reason: "manual",
      baseCoveredCount: 40,
      baseCheckpointId: "cp_40",
      now: 2_000,
    });
    expect(running).toMatchObject({
      version: COMPACTION_STATE_VERSION,
      status: "compacting",
      attemptId: "cmp_1",
      reason: "manual",
      attemptsUsed: 0,
      lastError: null,
      baseCoveredCount: 40,
      baseCheckpointId: "cp_40",
      updatedAt: 2_000,
    });

    const done = markCompactionSuccess(running, {
      baseCoveredCount: 80,
      baseCheckpointId: "cp_80",
      now: 3_000,
    });
    expect(done).toEqual({
      version: COMPACTION_STATE_VERSION,
      status: "idle",
      attemptId: null,
      reason: null,
      attemptsUsed: 0,
      lastError: null,
      baseCoveredCount: 80,
      baseCheckpointId: "cp_80",
      bootRetryAttempted: false,
      fallbackSuppressed: false,
      updatedAt: 3_000,
    });
  });

  it("retry_pending keeps attempt identity/base and a new begin resets the budget", () => {
    const running = beginCompaction(idleState(10), {
      attemptId: "cmp_2",
      reason: "watermark",
      baseCoveredCount: 12,
      now: 20,
    });
    const failed = markCompactionFailure(running, {
      lastError: "503 upstream unavailable",
      attemptsUsed: 10,
      now: 30,
    });
    expect(failed).toMatchObject({
      status: "retry_pending",
      attemptId: "cmp_2",
      reason: "watermark",
      attemptsUsed: 10,
      lastError: "503 upstream unavailable",
      baseCoveredCount: 12,
      updatedAt: 30,
    });

    const resumed = beginCompaction(failed, {
      attemptId: "cmp_3",
      reason: "manual",
      now: 40,
    });
    expect(resumed).toMatchObject({
      status: "compacting",
      attemptId: "cmp_3",
      reason: "manual",
      attemptsUsed: 0,
      lastError: null,
      baseCoveredCount: 12,
    });
  });

  it("user abort returns to idle without touching base", () => {
    const running = beginCompaction(idleState(10), {
      attemptId: "cmp_4",
      reason: "manual",
      baseCoveredCount: 7,
      baseCheckpointId: "cp_7",
      now: 20,
    });
    const aborted = markCompactionAborted(running, { now: 30 });
    expect(aborted).toMatchObject({
      status: "idle",
      attemptId: null,
      reason: null,
      attemptsUsed: 0,
      lastError: null,
      baseCoveredCount: 7,
      baseCheckpointId: "cp_7",
      fallbackSuppressed: false,
      updatedAt: 30,
    });
  });

  it("aborting a fallback compaction suppresses fallback until explicitly cleared", () => {
    const fallback = beginCompaction(idleState(1), {
      attemptId: "cmp_fallback",
      reason: "fallback",
      now: 2,
    });
    const aborted = markCompactionAborted(fallback, { now: 3 });
    expect(aborted.status).toBe("idle");
    expect(aborted.fallbackSuppressed).toBe(true);

    const manual = beginCompaction(aborted, { attemptId: "cmp_manual", reason: "manual", now: 4 });
    expect(manual.fallbackSuppressed).toBe(true);
    const manualAborted = markCompactionAborted(manual, { now: 5 });
    expect(manualAborted.fallbackSuppressed).toBe(true);

    const cleared = clearFallbackSuppression(manualAborted, 6);
    expect(cleared.fallbackSuppressed).toBe(false);
    expect(cleared.updatedAt).toBe(6);

    const suppressed = suppressFallback(cleared, 7);
    expect(suppressed.fallbackSuppressed).toBe(true);
    expect(suppressed.updatedAt).toBe(7);
  });

  it("boot retry consumption is persisted without changing status", () => {
    const pending = markCompactionFailure(
      beginCompaction(idleState(1), { attemptId: "cmp_boot", reason: "tool", now: 2 }),
      { lastError: "timeout", attemptsUsed: 10, now: 3 },
    );
    const consumed = markBootRetryConsumed(pending, 4);
    expect(consumed.status).toBe("retry_pending");
    expect(consumed.bootRetryAttempted).toBe(true);
    expect(consumed.updatedAt).toBe(4);
  });

  it("rejects double begin and transitions from the wrong status", () => {
    const running = beginCompaction(idleState(1), { attemptId: "cmp_x", reason: "manual", now: 2 });
    expect(() =>
      beginCompaction(running, { attemptId: "cmp_y", reason: "manual", now: 3 }),
    ).toThrow(/already compacting/);
    expect(() => markCompactionSuccess(idleState(1))).toThrow(/expected status "compacting"/);
    expect(() =>
      markCompactionFailure(idleState(1), { lastError: "x", attemptsUsed: 1 }),
    ).toThrow(/expected status "compacting"/);
    expect(() => markCompactionAborted(idleState(1))).toThrow(/expected status "compacting"/);
  });
});

describe("isCompactionState", () => {
  it("accepts a freshly built idle state", () => {
    expect(isCompactionState(idleState(1))).toBe(true);
  });

  it("rejects non-objects and every broken contract field", () => {
    const valid = idleState(1);
    const broken: unknown[] = [
      null,
      [],
      "idle",
      { ...valid, version: 2 },
      { ...valid, status: "running" },
      { ...valid, reason: "auto" },
      { ...valid, attemptsUsed: -1 },
      { ...valid, attemptsUsed: 1.5 },
      { ...valid, attemptsUsed: Number.POSITIVE_INFINITY },
      { ...valid, attemptId: "" },
      { ...valid, attemptId: undefined },
      { ...valid, lastError: 42 },
      { ...valid, baseCoveredCount: -2 },
      { ...valid, baseCheckpointId: 5 },
      { ...valid, bootRetryAttempted: "false" },
      { ...valid, fallbackSuppressed: 0 },
      { ...valid, updatedAt: Number.NaN },
      { ...valid, updatedAt: -1 },
    ];
    for (const value of broken) {
      expect(isCompactionState(value), JSON.stringify(value)).toBe(false);
    }
  });

  it("accepts nullable attempt/reason and non-zero counters", () => {
    const state = {
      ...idleState(1),
      attemptsUsed: 10,
      baseCoveredCount: 120,
      updatedAt: 1_234.5,
    };
    expect(isCompactionState(state)).toBe(true);
  });
});
