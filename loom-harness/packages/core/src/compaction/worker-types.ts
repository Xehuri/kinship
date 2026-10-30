/**
 * W57 压缩 worker 的公开类型契约。
 *
 * 仅类型，无运行时依赖；`worker.ts` 负责再导出，barrel 无需改动。
 */

import type { Message } from "@earendil-works/pi-ai";
import type { HookContext } from "../hook.js";
import type { CompactionReason } from "./compaction-state.js";
import type { CompactionStateStore } from "./compaction-state-store.js";
import type { CompactionErrorClass } from "./compaction-retry.js";

/** 压缩摘要的流式增量；chunk 由 summarize-prefix 在分块编排时补上。 */
export interface SummarizeDelta {
  readonly part: "reasoning" | "content";
  readonly delta: string;
  readonly chunk?: number;
}

export type SummarizeFn = (
  messages: Message[],
  ctx: HookContext,
  onDelta?: (delta: SummarizeDelta) => void,
) => string | Promise<string>;

/** 成功提交时交给 `commit` 回调的不可变载荷。 */
export interface CompactionCommit {
  readonly attemptId: string;
  readonly reason: CompactionReason;
  /** 折进 summary 的前缀条数（raw 坐标）。 */
  readonly coveredCount: number;
  /** 将进 L0 的 summary message（= wrapSummary 文本）。 */
  readonly summary: Message;
  /** 校验/trim 后的摘要正文。 */
  readonly summaryText: string;
  readonly checkpointId: string;
  /** 未覆盖尾巴第一条消息的时间；全部覆盖时为 null。 */
  readonly anchorTimestampMs: number | null;
  /** worker commit 的 summary 永不内嵌 tail；固定 false（重放据此保留未覆盖尾巴）。 */
  readonly tailIncluded?: boolean;
}

/** 每次 attempt 开始时抓取一次的只读快照。 */
export interface CompactionContextSnapshot {
  readonly raw: Message[];
  /** live 已折进 summary 的前缀条数（bounded floor）。 */
  readonly prevCovered: number;
  /** 原样传给 summarize 的不透明上下文。 */
  readonly ctx: HookContext;
}

/** 额外摘要视角；主视角恒为 ops，段落标题与合并提示词可独立覆盖。 */
export interface CompactionSummaryPerspective {
  readonly key: string;
  readonly title: string;
  readonly summarize: SummarizeFn;
  readonly buildMergePrompt?: (partials: readonly string[]) => string;
}

export interface CompactionWorkerDeps {
  /** sidecar 文件名所用的 session id。 */
  readonly sessionId: string;
  readonly stateStore: CompactionStateStore;
  readonly summarize: SummarizeFn;
  /** 除主 ops 视角外还要生成的摘要视角；缺省 = 旧的单摘要路径。 */
  readonly additionalSummaryPerspectives?: readonly CompactionSummaryPerspective[];
  readonly commit: (commit: CompactionCommit) => Promise<void>;
  readonly context: () => CompactionContextSnapshot;
  readonly wrapSummary: (text: string, coveredCount: number) => string;
  /** 摘要输入的纯投影（只影响 summarize 入参，不改 raw 坐标/提交边界）。 */
  readonly projectSummaryInput?: (messages: Message[]) => Message[];
}

export interface CompactionWorkerOptions {
  /** 压缩后保留的最近消息条数下限（>= 1）。 */
  readonly keepRecent: number;
  /** recent tail 的 token 预算；缺省只按 keepRecent 条数。 */
  readonly keepRecentTokens?: number;
  /** 已有 boundary 时，至少新增这么多条才重新摘要；默认 1。 */
  readonly resummarizeEvery?: number;
  /** 单次 summarize 输入的 token 上限（P2a 分块大小）。 */
  readonly summaryChunkTokens: number;
  /** 摘要调用模式；缺省按是否提供 singleCallBudgetTokens 推导（auto / chunked）。 */
  readonly summaryMode?: "auto" | "single" | "chunked";
  /** 单次调用 token 预算；single / auto 必填且须为正安全整数。 */
  readonly singleCallBudgetTokens?: number;
  /** auto 最大递归拆分深度（>= 0）；缺省在 settings 中取 2。 */
  readonly summaryMaxSplitDepth?: number;
  /** 每次 summarize 调用的超时（ms），默认 300000。 */
  readonly requestTimeoutMs?: number;
  /** 整个 attempt 共享的重试次数，默认 10（= 11 次总尝试）。 */
  readonly retryCount?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly onEvent?: (event: CompactionWorkerEvent) => void;
}

export interface StartCompactionInput {
  readonly reason: CompactionReason;
  /** 覆盖下限（不得低于 prevCovered）；缺省 = prevCovered。 */
  readonly floor?: number;
  readonly attemptId?: string;
}

export type CompactionWorkerEvent =
  | {
      readonly type: "started";
      readonly attemptId: string;
      readonly reason: CompactionReason;
    }
  | {
      readonly type: "delta";
      readonly attemptId: string;
      readonly chunk: number;
      readonly retry: number;
      readonly part: "reasoning" | "content";
      readonly delta: string;
      readonly perspective?: string;
    }
  | {
      readonly type: "retrying";
      readonly attemptId: string;
      readonly retry: number;
      readonly delayMs: number;
      readonly errorClass: CompactionErrorClass;
      readonly error: Error;
      readonly perspective?: string;
    }
  | {
      readonly type: "succeeded";
      readonly attemptId: string;
      readonly coveredCount: number;
      readonly checkpointId: string;
      readonly attemptsUsed: number;
    }
  | {
      readonly type: "noop";
      readonly attemptId: string;
      readonly coveredCount: number;
    }
  | {
      readonly type: "failed";
      readonly attemptId: string;
      readonly errorClass: CompactionErrorClass;
      readonly attemptsUsed: number;
      readonly error: Error;
      readonly perspective?: string;
    }
  | {
      readonly type: "aborted";
      readonly attemptId: string;
      readonly abortReason: string | null;
      readonly attemptsUsed: number;
    };

export type WorkerOutcome =
  | {
      readonly ok: true;
      readonly kind: "compacted";
      readonly attemptId: string;
      readonly reason: CompactionReason;
      readonly coveredCount: number;
      readonly summary: Message;
      readonly summaryText: string;
      readonly checkpointId: string;
      readonly anchorTimestampMs: number | null;
      readonly attemptsUsed: number;
    }
  | {
      readonly ok: true;
      readonly kind: "noop";
      readonly attemptId: string;
      readonly reason: CompactionReason;
      readonly coveredCount: number;
    }
  | {
      readonly ok: false;
      readonly kind: "failed";
      readonly attemptId: string;
      readonly reason: CompactionReason;
      readonly error: Error;
      readonly errorClass: CompactionErrorClass;
      readonly attemptsUsed: number;
    }
  | {
      readonly ok: false;
      readonly kind: "aborted";
      readonly attemptId: string;
      readonly reason: CompactionReason;
      readonly abortReason: string | null;
      readonly attemptsUsed: number;
    };
