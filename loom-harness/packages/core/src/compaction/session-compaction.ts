/**
 * W57 P2c-2：`AgentSession` 的会话级压缩接线契约。
 *
 * `SessionCompactionOptions` 是调用方注入给 `AgentSessionOptions.compaction` 的依赖集合：
 * state sidecar、summarizer、绝对 fallback 阈值与 worker 参数。它不读生产配置、不建
 * HTTP/SSE/tool 面；server 侧目前只在类型上透传（`SessionRegistryOptions.compaction`），
 * 由后续装配波次决定 stateRoot / summarize 的真实来源。
 *
 * 错误类型是 `_phaseLlmCall` 的公开失败面：
 *   - `CompactionFailedError`：本次压缩 outcome 为 failed/aborted，turn 必须失败；
 *     sidecar 在 failed 时由 worker 写成 retry_pending，下一轮 LLM 前会自动重试。
 *   - `CompactionRecoveryRequiredError`：sidecar 停在 compacting 而本进程没有在飞
 *     worker（崩溃残留）。当前不自动恢复，留给 boot 恢复接线；见 coordinator
 *     `recoverStaleCompacting()`。
 */

import type { Message } from "@earendil-works/pi-ai";
import type { CompactionStateStore } from "./compaction-state-store.js";
import type { SummaryMode } from "./summarize-prefix.js";
import type {
  CompactionSummaryPerspective,
  CompactionWorkerEvent,
  SummarizeFn,
  WorkerOutcome,
} from "./worker.js";

/** 失败的 worker outcome（failed / aborted 两支）。 */
export type FailedCompactionOutcome = Extract<WorkerOutcome, { readonly ok: false }>;

/** `AgentSession` 的会话级压缩依赖（每 session 一份 worker/coordinator）。 */
export interface SessionCompactionOptions {
  /** 压缩状态 sidecar（`<stateRoot>/session/compaction-state/<sid>.json`）。 */
  readonly stateStore: CompactionStateStore;
  /** 前缀摘要函数；失败按 worker 的重试预算处理。 */
  readonly summarize: SummarizeFn;
  /** 把摘要正文包成一条 user message（worker commit 的 summary 字节）。 */
  readonly wrapSummary: (text: string, coveredCount: number) => string;
  /**
   * 自动 fallback 的绝对 token 阈值（必填，无硬编码缺省）。LLM 调用前的请求估算
   * `>= fallbackTokens` 时触发 reason="fallback" 的压缩。与会话里既有
   * `maxContextTokens` / `triggerRatio` 的 autoCompaction hook 是**独立路径**：
   * 本路径不看那两个键。
   */
  readonly fallbackTokens: number;
  /**
   * P3 上下文水位档位（绝对 token 数，可选）。每档须为有限正整数、严格递增、且
   * 全部小于 `fallbackTokens`（构造期 `assertValidWatermarkLevels` 校验）。
   * 投影请求体积跨过某档时，内核向 `_messages` append 一条持久
   * `<system-reminder>` notice（每档至多一次，跳级只发最高档）。
   */
  readonly watermarkLevels?: readonly number[];
  /** 压缩后保留的最近消息条数下限（worker 参数，>= 1）。 */
  readonly keepRecent: number;
  /** recent tail 的 token 预算（可选；缺省只按 keepRecent 条数）。 */
  readonly keepRecentTokens?: number;
  /** 已有 boundary 时至少新增多少条才重新摘要（worker 参数，默认 1）。 */
  readonly resummarizeEvery?: number;
  /** 单次 summarize 输入的 token 上限（P2a 分块大小）。 */
  readonly summaryChunkTokens: number;
  /** 摘要调用模式；缺省按是否提供 singleCallBudgetTokens 推导。 */
  readonly summaryMode?: SummaryMode;
  /** 单次调用 token 预算；summaryMode=single/auto 时必填且须为正安全整数。 */
  readonly singleCallBudgetTokens?: number;
  /** auto 最大递归拆分深度（>= 0）。 */
  readonly summaryMaxSplitDepth?: number;
  /** 摘要输入纯投影；只影响 summarize 入参，不改 commit 的 raw 坐标。 */
  readonly projectSummaryInput?: (messages: Message[]) => Message[];
  /** 额外摘要视角（如 chat）；缺省 = 仅 ops 单摘要。 */
  readonly additionalSummaryPerspectives?: readonly CompactionSummaryPerspective[];
  /** 每次 summarize 调用的超时（ms）。 */
  readonly requestTimeoutMs?: number;
  /** 整个 attempt 共享的重试次数。 */
  readonly retryCount?: number;
  /** worker 事件观察者（started/delta/retrying/succeeded/failed/...）。 */
  readonly onEvent?: (event: CompactionWorkerEvent) => void;
  /** W57 P5：SSE 节流参数；缺席 = server 发布器缺省 50ms / 4096B。 */
  readonly stream?: {
    readonly flushIntervalMs?: number;
    readonly flushMaxBytes?: number;
  };
}

/** 压缩 outcome 为 failed/aborted 时 `_phaseLlmCall` 抛出的错误。 */
export class CompactionFailedError extends Error {
  readonly outcome: FailedCompactionOutcome;

  constructor(outcome: FailedCompactionOutcome) {
    super(messageForOutcome(outcome), outcome.kind === "failed" ? { cause: outcome.error } : undefined);
    this.name = "CompactionFailedError";
    this.outcome = outcome;
  }
}

/**
 * sidecar 停在 `compacting`、但本进程没有在飞 worker：崩溃残留，正常 LLM 调用必须
 * 拒绝启动。boot 恢复接线可先调用 `CompactionCoordinator.recoverStaleCompacting()`
 * 把它迁到 retry_pending，再让 `_prepareCompactionForLlm` 走重试路径。
 */
export class CompactionRecoveryRequiredError extends Error {
  readonly sessionId: string;
  readonly attemptId: string | null;

  constructor(sessionId: string, attemptId: string | null) {
    super(
      `session ${sessionId} has a stale compacting state` +
        `${attemptId === null ? "" : ` (attempt ${attemptId})`}; ` +
        "boot recovery is required before the next LLM call " +
        "(CompactionCoordinator.recoverStaleCompacting())",
    );
    this.name = "CompactionRecoveryRequiredError";
    this.sessionId = sessionId;
    this.attemptId = attemptId;
  }
}

function messageForOutcome(outcome: FailedCompactionOutcome): string {
  if (outcome.kind === "failed") {
    return `compaction failed (${outcome.reason}): ${outcome.error.message}`;
  }
  return outcome.abortReason === null
    ? `compaction aborted (${outcome.reason})`
    : `compaction aborted (${outcome.reason}): ${outcome.abortReason}`;
}
