/**
 * W57 后台压缩 worker 的公开入口与生命周期。
 *
 * 本层只做：状态读取/迁移、sidecar 写入、事件发射、单 worker 并发门闩、abort/wait。
 * 单次 attempt 的编排在 worker-attempt.ts；重试/超时在 worker-retry.ts；类型与错误分别在
 * worker-types.ts / worker-errors.ts。这里重新导出全部公开名字，保持 `./worker.js` 的导入面不变。
 *
 * 纪律：只依赖注入回调，不 import session、store、SSE 或生产配置；不硬编码水位/750k。
 * `done` 只在基础设施/程序错误（状态写失败、非法迁移）时 reject；摘要失败、重试耗尽、commit 失败、
 * 用户 abort 一律 resolve 带 kind 的 outcome。无聚合 deadline。
 */

import { randomUUID } from "node:crypto";
import {
  beginCompaction,
  idleState,
  type CompactionState,
} from "./compaction-state.js";
import { runCompactionAttempt, type AttemptPlan, type AttemptSettings } from "./worker-attempt.js";
import {
  CompactionBusyError,
  CompactionNotRunningError,
  CompactionStateWriteError,
} from "./worker-errors.js";
import type {
  CompactionSummaryPerspective,
  CompactionWorkerDeps,
  CompactionWorkerEvent,
  CompactionWorkerOptions,
  StartCompactionInput,
  WorkerOutcome,
} from "./worker-types.js";

export type {
  CompactionCommit,
  CompactionContextSnapshot,
  CompactionSummaryPerspective,
  CompactionWorkerDeps,
  CompactionWorkerEvent,
  CompactionWorkerOptions,
  StartCompactionInput,
  SummarizeFn,
  WorkerOutcome,
} from "./worker-types.js";
export {
  COMPACTION_SUMMARY_MAX_CHARS,
  COMPACTION_SUMMARY_MIN_CHARS,
  CompactionAbortedError,
  CompactionBusyError,
  CompactionNotRunningError,
  CompactionRequestTimeoutError,
  CompactionStateWriteError,
  CompactionSummaryValidationError,
} from "./worker-errors.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_RETRY_COUNT = 10;

interface RunningAttempt {
  readonly attemptId: string;
  readonly done: Promise<WorkerOutcome>;
}

function assertIntegerInRange(value: number, min: number, label: string): void {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${label} must be an integer >= ${String(min)} (got ${String(value)})`);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertAdditionalSummaryPerspectives(
  perspectives: readonly CompactionSummaryPerspective[] | undefined,
): void {
  if (perspectives === undefined) return;
  if (!Array.isArray(perspectives) || perspectives.length === 0) {
    throw new RangeError("additionalSummaryPerspectives must be a non-empty array");
  }
  const keys = new Set<string>();
  for (const perspective of perspectives) {
    if (perspective === null || typeof perspective !== "object") {
      throw new Error("additionalSummaryPerspectives entries must be objects");
    }
    if (typeof perspective.key !== "string" || perspective.key.trim().length === 0) {
      throw new RangeError("additionalSummaryPerspectives key must be a non-empty string");
    }
    if (typeof perspective.title !== "string" || perspective.title.trim().length === 0) {
      throw new RangeError(
        `additionalSummaryPerspectives["${perspective.key}"].title must be a non-empty string`,
      );
    }
    if (perspective.key === "ops") {
      throw new RangeError(
        'additionalSummaryPerspectives key "ops" is reserved for the primary perspective',
      );
    }
    if (keys.has(perspective.key)) {
      throw new RangeError(
        `additionalSummaryPerspectives contains duplicate key "${perspective.key}"`,
      );
    }
    keys.add(perspective.key);
    if (typeof perspective.summarize !== "function") {
      throw new Error(
        `additionalSummaryPerspectives["${perspective.key}"].summarize must be a function`,
      );
    }
  }
}

/**
 * 一个 worker 服务一个 session：同一时刻最多一个 attempt；完成后可再次 start。
 * 所有状态迁移都先写 sidecar 再发事件（事件观察者失败不影响压缩）。
 */
export class CompactionWorker {
  readonly #deps: CompactionWorkerDeps;
  readonly #settings: AttemptSettings;
  readonly #now: () => number;
  readonly #onEvent: ((event: CompactionWorkerEvent) => void) | undefined;

  #running: RunningAttempt | null = null;
  #lastOutcome: WorkerOutcome | null = null;
  #abort: AbortController | null = null;
  #abortReason: string | null = null;

  constructor(deps: CompactionWorkerDeps, options: CompactionWorkerOptions) {
    if (deps.sessionId.length === 0) throw new Error("CompactionWorker: sessionId must be non-empty");
    assertAdditionalSummaryPerspectives(deps.additionalSummaryPerspectives);
    assertIntegerInRange(options.keepRecent, 1, "keepRecent");
    if (options.keepRecentTokens !== undefined) {
      if (!Number.isFinite(options.keepRecentTokens) || options.keepRecentTokens < 0) {
        throw new RangeError("keepRecentTokens must be a finite number >= 0");
      }
    }
    const resummarizeEvery = options.resummarizeEvery ?? 1;
    assertIntegerInRange(resummarizeEvery, 1, "resummarizeEvery");
    assertIntegerInRange(options.summaryChunkTokens, 1, "summaryChunkTokens");
    const summaryMode =
      options.summaryMode ??
      (options.singleCallBudgetTokens === undefined ? "chunked" : "auto");
    if (summaryMode !== "chunked") {
      const budget = options.singleCallBudgetTokens;
      if (budget === undefined || !Number.isSafeInteger(budget) || budget <= 0) {
        throw new RangeError(
          `singleCallBudgetTokens must be a positive safe integer when summaryMode is "${summaryMode}" (got ${String(budget)})`,
        );
      }
    }
    if (options.summaryMaxSplitDepth !== undefined) {
      assertIntegerInRange(options.summaryMaxSplitDepth, 0, "summaryMaxSplitDepth");
    }
    const summaryMaxSplitDepth = options.summaryMaxSplitDepth ?? 2;
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new RangeError("requestTimeoutMs must be a finite number > 0");
    }
    const retryCount = options.retryCount ?? DEFAULT_RETRY_COUNT;
    assertIntegerInRange(retryCount, 0, "retryCount");

    this.#deps = deps;
    this.#settings = {
      keepRecent: options.keepRecent,
      keepRecentTokens: options.keepRecentTokens,
      resummarizeEvery,
      summaryChunkTokens: options.summaryChunkTokens,
      summaryMode,
      singleCallBudgetTokens: options.singleCallBudgetTokens,
      summaryMaxSplitDepth,
      requestTimeoutMs,
      retryCount,
      sleep: options.sleep ?? defaultSleep,
      random: options.random ?? Math.random,
    };
    this.#now = options.now ?? Date.now;
    this.#onEvent = options.onEvent;
  }

  get isRunning(): boolean {
    return this.#running !== null;
  }

  /** 在飞 attempt 的 done；无在飞时返回最近一次 outcome；都没有则抛 `CompactionNotRunningError`。 */
  wait(): Promise<WorkerOutcome> {
    if (this.#running !== null) return this.#running.done;
    if (this.#lastOutcome !== null) return Promise.resolve(this.#lastOutcome);
    throw new CompactionNotRunningError();
  }

  /** 用户 abort：只作用于在飞 attempt；空闲时是 no-op。 */
  abort(reason?: string): void {
    if (this.#running === null) return;
    this.#abortReason = reason ?? null;
    this.#abort?.abort();
  }

  /**
   * 启动一次 attempt。状态读/写与 started 事件都在本调用内同步完成；返回后 attempt 在后台跑。
   * sidecar 仍是 compacting（或本 worker 有在飞 attempt）→ 抛 `CompactionBusyError`。
   * 起始状态写失败 → 抛 `CompactionStateWriteError`，不会开始 attempt。
   */
  start(input: StartCompactionInput): { attemptId: string; done: Promise<WorkerOutcome> } {
    if (this.#running !== null) throw new CompactionBusyError(this.#running.attemptId);
    if (input.floor !== undefined) assertIntegerInRange(input.floor, 0, "floor");

    const prior = this.#readState();
    if (prior.status === "compacting") throw new CompactionBusyError(prior.attemptId);

    const snapshot = this.#deps.context();
    const attemptId = input.attemptId ?? randomUUID();
    const floor = Math.max(snapshot.prevCovered, input.floor ?? snapshot.prevCovered);
    const began = beginCompaction(prior, {
      attemptId,
      reason: input.reason,
      baseCoveredCount: snapshot.prevCovered,
      now: this.#now(),
    });
    this.#writeState(began, "begin");

    const controller = new AbortController();
    this.#abort = controller;
    this.#abortReason = null;
    this.#emit({ type: "started", attemptId, reason: input.reason });

    const plan: AttemptPlan = {
      attemptId,
      reason: input.reason,
      snapshot,
      floor,
      began,
      signal: controller.signal,
    };
    const done = (async (): Promise<WorkerOutcome> => {
      try {
        // 让 start() 先返回并注册 #running，再执行 attempt 主体（避免同步 noop 的注册竞态）。
        await Promise.resolve();
        const outcome = await runCompactionAttempt(plan, {
          deps: this.#deps,
          settings: this.#settings,
          now: this.#now,
          writeState: (state, action) => this.#writeState(state, action),
          emit: (event) => this.#emit(event),
          abortReason: () => this.#abortReason,
        });
        this.#lastOutcome = outcome;
        return outcome;
      } finally {
        this.#running = null;
      }
    })();
    this.#running = { attemptId, done };
    return { attemptId, done };
  }

  #readState(): CompactionState {
    const result = this.#deps.stateStore.read(this.#deps.sessionId);
    // missing/corrupt 都从 idle 起（base 以 context().prevCovered 为准）；boot 恢复不属于本 worker。
    return result.kind === "ok" ? result.state : idleState(this.#now());
  }

  #writeState(state: CompactionState, action: string): void {
    try {
      this.#deps.stateStore.write(this.#deps.sessionId, state);
    } catch (cause) {
      throw new CompactionStateWriteError(action, cause);
    }
  }

  #emit(event: CompactionWorkerEvent): void {
    if (this.#onEvent === undefined) return;
    try {
      this.#onEvent(event);
    } catch {
      /* 观察者失败不得影响压缩主流程 */
    }
  }
}
