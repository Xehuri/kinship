/**
 * W57 压缩 worker 的单次 attempt 编排。
 *
 * 输入是 worker 生命周期层抓好的只读快照 + 状态写入/事件回调；本模块不持有 worker 状态，
 * 只负责：选边界、走 P2a 前缀摘要、按 P1 预算重试、commit、落 success/failure/abort 状态。
 */

import { randomUUID } from "node:crypto";
import { chooseTailStart } from "../plugins/auto-compaction.js";
import { createUserMessage } from "../types.js";
import {
  markCompactionAborted,
  markCompactionFailure,
  markCompactionSuccess,
  type CompactionReason,
  type CompactionState,
} from "./compaction-state.js";
import {
  CompactionRetryBudget,
  classifyCompactionError,
  type CompactionErrorClass,
} from "./compaction-retry.js";
import { summarizeCompactionPrefix, type SummaryMode } from "./summarize-prefix.js";
import {
  CompactionAbortedError,
  CompactionStateWriteError,
  toError,
} from "./worker-errors.js";
import {
  summarizeWithRetry,
  throwIfAborted,
  validateSummaryText,
  type RetryHooks,
  type RetrySettings,
} from "./worker-retry.js";
import type {
  CompactionCommit,
  CompactionContextSnapshot,
  CompactionSummaryPerspective,
  CompactionWorkerDeps,
  CompactionWorkerEvent,
  WorkerOutcome,
} from "./worker-types.js";

export interface AttemptSettings {
  readonly keepRecent: number;
  readonly keepRecentTokens: number | undefined;
  readonly resummarizeEvery: number;
  readonly summaryChunkTokens: number;
  readonly summaryMode: SummaryMode;
  readonly singleCallBudgetTokens: number | undefined;
  readonly summaryMaxSplitDepth: number;
  readonly requestTimeoutMs: number;
  readonly retryCount: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
}

export interface AttemptPlan {
  readonly attemptId: string;
  readonly reason: CompactionReason;
  readonly snapshot: CompactionContextSnapshot;
  readonly floor: number;
  readonly began: CompactionState;
  readonly signal: AbortSignal;
}

export interface AttemptRuntime {
  readonly deps: CompactionWorkerDeps;
  readonly settings: AttemptSettings;
  readonly now: () => number;
  readonly writeState: (state: CompactionState, action: string) => void;
  readonly emit: (event: CompactionWorkerEvent) => void;
  readonly abortReason: () => string | null;
}

export async function runCompactionAttempt(
  plan: AttemptPlan,
  runtime: AttemptRuntime,
): Promise<WorkerOutcome> {
  const budget = new CompactionRetryBudget({ maxRetries: runtime.settings.retryCount });
  const { raw, prevCovered, ctx } = plan.snapshot;
  const retrySettings: RetrySettings = {
    requestTimeoutMs: runtime.settings.requestTimeoutMs,
    sleep: runtime.settings.sleep,
    random: runtime.settings.random,
  };
  const retryHooks: RetryHooks = {
    signal: plan.signal,
    abortReason: runtime.abortReason,
    onRetry: (info) =>
      runtime.emit({ type: "retrying", attemptId: plan.attemptId, ...info }),
  };
  let perspectiveKey: string | undefined;

  try {
    throwIfAborted(plan.signal, runtime.abortReason);
    const targetCover = chooseTailStart(raw, {
      ...(runtime.settings.keepRecentTokens === undefined
        ? {}
        : { keepRecentTokens: runtime.settings.keepRecentTokens }),
      keepRecent: runtime.settings.keepRecent,
      floor: plan.floor,
      hasPrevious: prevCovered > 0,
    });
    const coveredCount = Math.max(0, Math.min(targetCover, raw.length));
    const growth = coveredCount - prevCovered;
    const belowGrowthFloor = prevCovered > 0 && growth < runtime.settings.resummarizeEvery;
    if (coveredCount <= plan.floor || belowGrowthFloor) {
      return finishNoop(plan, runtime, coveredCount);
    }

    const additionalPerspectives = runtime.deps.additionalSummaryPerspectives;
    let summaryText: string;
    if (additionalPerspectives === undefined || additionalPerspectives.length === 0) {
      summaryText = validateSummaryText(
        await summarizeCompactionPrefix({
          prefix: raw.slice(0, coveredCount),
          summarize: (messages, callCtx, onDelta) =>
            summarizeWithRetry(
              messages,
              callCtx,
              runtime.deps.summarize,
              budget,
              retrySettings,
              retryHooks,
              onDelta,
            ),
          summaryChunkTokens: runtime.settings.summaryChunkTokens,
          summaryMode: runtime.settings.summaryMode,
          summaryMaxSplitDepth: runtime.settings.summaryMaxSplitDepth,
          ...(runtime.settings.singleCallBudgetTokens === undefined
            ? {}
            : { singleCallBudgetTokens: runtime.settings.singleCallBudgetTokens }),
          ...(runtime.deps.projectSummaryInput === undefined
            ? {}
            : { summaryProjection: runtime.deps.projectSummaryInput }),
          ctx,
          onDelta: (delta) =>
            runtime.emit({
              type: "delta",
              attemptId: plan.attemptId,
              chunk: delta.chunk ?? 0,
              retry: budget.used,
              part: delta.part,
              delta: delta.delta,
            }),
        }),
      );
    } else {
      const perspectives: readonly CompactionSummaryPerspective[] = [
        { key: "ops", title: "OPS STATE", summarize: runtime.deps.summarize },
        ...additionalPerspectives,
      ];
      const parts: Array<{ readonly title: string; readonly text: string }> = [];
      for (const perspective of perspectives) {
        perspectiveKey = perspective.key;
        const perspectiveRetryHooks: RetryHooks = {
          signal: plan.signal,
          abortReason: runtime.abortReason,
          onRetry: (info) =>
            runtime.emit({
              type: "retrying",
              attemptId: plan.attemptId,
              perspective: perspective.key,
              ...info,
            }),
        };
        const text = validateSummaryText(
          await summarizeCompactionPrefix({
            prefix: raw.slice(0, coveredCount),
            summarize: (messages, callCtx, onDelta) =>
              summarizeWithRetry(
                messages,
                callCtx,
                perspective.summarize,
                budget,
                retrySettings,
                perspectiveRetryHooks,
                onDelta,
              ),
            summaryChunkTokens: runtime.settings.summaryChunkTokens,
            summaryMode: runtime.settings.summaryMode,
            summaryMaxSplitDepth: runtime.settings.summaryMaxSplitDepth,
            ...(runtime.settings.singleCallBudgetTokens === undefined
              ? {}
              : { singleCallBudgetTokens: runtime.settings.singleCallBudgetTokens }),
            ...(runtime.deps.projectSummaryInput === undefined
              ? {}
              : { summaryProjection: runtime.deps.projectSummaryInput }),
            ...(perspective.buildMergePrompt === undefined
              ? {}
              : { buildMergePrompt: perspective.buildMergePrompt }),
            ctx,
            onDelta: (delta) =>
              runtime.emit({
                type: "delta",
                attemptId: plan.attemptId,
                chunk: delta.chunk ?? 0,
                retry: budget.used,
                part: delta.part,
                delta: delta.delta,
                perspective: perspective.key,
              }),
          }),
        );
        parts.push({ title: perspective.title, text });
      }
      perspectiveKey = undefined;
      summaryText = validateSummaryText(
        parts.map(({ title, text }) => "## " + title + "\n\n" + text).join("\n\n"),
      );
    }
    throwIfAborted(plan.signal, runtime.abortReason);

    const checkpointId = randomUUID();
    const commit: CompactionCommit = {
      attemptId: plan.attemptId,
      reason: plan.reason,
      coveredCount,
      summary: createUserMessage(runtime.deps.wrapSummary(summaryText, coveredCount)),
      summaryText,
      checkpointId,
      anchorTimestampMs: raw[coveredCount]?.timestamp ?? null,
      tailIncluded: false,
    };
    await runtime.deps.commit(commit);

    const state = markCompactionSuccess(plan.began, {
      baseCoveredCount: coveredCount,
      baseCheckpointId: checkpointId,
      now: runtime.now(),
    });
    runtime.writeState(state, "success");
    runtime.emit({
      type: "succeeded",
      attemptId: plan.attemptId,
      coveredCount,
      checkpointId,
      attemptsUsed: budget.used,
    });
    return {
      ok: true,
      kind: "compacted",
      attemptId: plan.attemptId,
      reason: plan.reason,
      coveredCount,
      summary: commit.summary,
      summaryText,
      checkpointId,
      anchorTimestampMs: commit.anchorTimestampMs,
      attemptsUsed: budget.used,
    };
  } catch (error) {
    if (error instanceof CompactionStateWriteError) throw error;
    if (
      plan.signal.aborted ||
      error instanceof CompactionAbortedError ||
      classifyCompactionError(error) === "abort"
    ) {
      return finishAborted(plan, runtime, budget);
    }
    return finishFailed(plan, runtime, budget, error, perspectiveKey);
  }
}

function finishNoop(plan: AttemptPlan, runtime: AttemptRuntime, coveredCount: number): WorkerOutcome {
  const state = markCompactionSuccess(plan.began, {
    baseCoveredCount: plan.began.baseCoveredCount,
    now: runtime.now(),
  });
  runtime.writeState(state, "noop");
  runtime.emit({ type: "noop", attemptId: plan.attemptId, coveredCount });
  return {
    ok: true,
    kind: "noop",
    attemptId: plan.attemptId,
    reason: plan.reason,
    coveredCount,
  };
}

function finishFailed(
  plan: AttemptPlan,
  runtime: AttemptRuntime,
  budget: CompactionRetryBudget,
  error: unknown,
  perspective: string | undefined,
): WorkerOutcome {
  const lastError = toError(error);
  const errorClass: CompactionErrorClass = classifyCompactionError(error);
  const state = markCompactionFailure(plan.began, {
    attemptsUsed: budget.used,
    lastError: lastError.message,
    now: runtime.now(),
  });
  runtime.writeState(state, "failure");
  runtime.emit({
    type: "failed",
    attemptId: plan.attemptId,
    errorClass,
    attemptsUsed: budget.used,
    error: lastError,
    ...(perspective === undefined ? {} : { perspective }),
  });
  return {
    ok: false,
    kind: "failed",
    attemptId: plan.attemptId,
    reason: plan.reason,
    error: lastError,
    errorClass,
    attemptsUsed: budget.used,
  };
}

function finishAborted(
  plan: AttemptPlan,
  runtime: AttemptRuntime,
  budget: CompactionRetryBudget,
): WorkerOutcome {
  const state = markCompactionAborted(plan.began, { now: runtime.now() });
  runtime.writeState(state, "abort");
  const abortReason = runtime.abortReason();
  runtime.emit({
    type: "aborted",
    attemptId: plan.attemptId,
    abortReason,
    attemptsUsed: budget.used,
  });
  return {
    ok: false,
    kind: "aborted",
    attemptId: plan.attemptId,
    reason: plan.reason,
    abortReason,
    attemptsUsed: budget.used,
  };
}
