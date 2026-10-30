/**
 * W57 会话级压缩协调器（P2c）：把 `AgentSession` 的两个新接口接到后台 `CompactionWorker`。
 *
 * 这是**纯适配层**：不实现重试、状态机或摘要逻辑（都在 P1/P2b），不碰 server/queue/HTTP/SSE。
 * 每个 coordinator 恰好持有该 session 的一个 worker（单 worker 并发门闩由 worker 自己保证），
 * attempt 起点用 `session.getCompactionSnapshot()`、成功提交用 `session.commitCompaction()`。
 */

import type { Message } from "@earendil-works/pi-ai";
import type { AgentSession } from "../session.js";
import { markCompactionFailure, type CompactionReason, type CompactionState } from "./compaction-state.js";
import type { CompactionStateStore } from "./compaction-state-store.js";
import { CompactionWorker } from "./worker.js";
import type {
  CompactionSummaryPerspective,
  CompactionWorkerEvent,
  CompactionWorkerOptions,
  SummarizeFn,
  WorkerOutcome,
} from "./worker.js";

/** 协调器依赖：summary 来源、sidecar 位置、worker 参数与可选事件观察者。 */
export interface CompactionCoordinatorOptions {
  readonly session: AgentSession;
  readonly stateStore: CompactionStateStore;
  readonly summarize: SummarizeFn;
  readonly wrapSummary: (text: string, coveredCount: number) => string;
  /** 去掉 `onEvent` 的 worker 参数；事件统一由本协调器的 `onEvent` 转发。 */
  readonly workerOptions: Omit<CompactionWorkerOptions, "onEvent">;
  /** 摘要输入纯投影；只影响 summarize 入参，不改 commit 的 raw 坐标。 */
  readonly projectSummaryInput?: (messages: Message[]) => Message[];
  /** 额外摘要视角；缺省 = 仅 ops 单摘要。 */
  readonly additionalSummaryPerspectives?: readonly CompactionSummaryPerspective[];
  readonly onEvent?: (event: CompactionWorkerEvent) => void;
}

export class CompactionCoordinator {
  readonly #session: AgentSession;
  readonly #stateStore: CompactionStateStore;
  readonly #worker: CompactionWorker;
  readonly #now: () => number;

  constructor(options: CompactionCoordinatorOptions) {
    this.#session = options.session;
    this.#stateStore = options.stateStore;
    this.#now = options.workerOptions.now ?? Date.now;
    this.#worker = new CompactionWorker(
      {
        sessionId: options.session.id,
        stateStore: options.stateStore,
        summarize: options.summarize,
        commit: (commit) => options.session.commitCompaction(commit),
        context: () => options.session.getCompactionSnapshot(),
        wrapSummary: options.wrapSummary,
        ...(options.projectSummaryInput === undefined
          ? {}
          : { projectSummaryInput: options.projectSummaryInput }),
        ...(options.additionalSummaryPerspectives === undefined
          ? {}
          : { additionalSummaryPerspectives: options.additionalSummaryPerspectives }),
      },
      {
        ...options.workerOptions,
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      },
    );
  }

  /** 启动一次后台压缩；并发/起始状态写失败语义与 `CompactionWorker.start` 相同。 */
  start(
    reason: CompactionReason,
    floor?: number,
  ): { attemptId: string; done: Promise<WorkerOutcome> } {
    return this.#worker.start({
      reason,
      ...(floor === undefined ? {} : { floor }),
    });
  }

  /** 等待在飞 attempt；无在飞时返回最近一次 outcome，从未启动则抛 `CompactionNotRunningError`。 */
  wait(): Promise<WorkerOutcome> {
    return this.#worker.wait();
  }

  /** 用户 abort：仅作用于在飞 attempt，空闲时 no-op。 */
  abort(reason?: string): void {
    this.#worker.abort(reason);
  }

  /**
   * boot 恢复缝隙的安全闭合：sidecar 停在 `compacting` 但本 coordinator 没有在飞
   * attempt（上个进程崩溃残留）时，把它迁到 `retry_pending`，让后续
   * `_prepareCompactionForLlm` 走正常重试路径。
   *
   * 安全条件：本进程有在飞 attempt 时直接返回 null（绝不改写活 worker 的状态）。
   * 不启动 attempt、不发事件；写盘失败原样抛出。没有可恢复状态也返回 null。
   * 当前 AgentSession 不自动调用本方法——见 `CompactionRecoveryRequiredError`。
   */
  recoverStaleCompacting(
    lastError = "stale compacting state from a previous process",
  ): CompactionState | null {
    if (this.#worker.isRunning) return null;
    const current = this.state;
    if (current === null || current.status !== "compacting") return null;
    const recovered = markCompactionFailure(current, {
      lastError,
      attemptsUsed: current.attemptsUsed,
      now: this.#now(),
    });
    this.#stateStore.write(this.#session.id, recovered);
    return recovered;
  }

  get isRunning(): boolean {
    return this.#worker.isRunning;
  }

  /** 当前 session 的 sidecar 快照；缺失/损坏返回 null（与 `CompactionStateStore.read` 一致）。 */
  get state(): CompactionState | null {
    const result = this.#stateStore.read(this.#session.id);
    return result.kind === "ok" ? result.state : null;
  }
}
