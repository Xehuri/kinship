/**
 * W57 压缩 worker 的错误类型与文本常量。
 *
 * 这些错误是 worker 与调用方之间的公开契约（barrel 经 worker.ts 再导出）。
 * `errorMessage` / `toError` / `asRecord` 是内部错误归一化工具，供 retry/attempt 复用。
 */

/** 摘要文本下限：低于 8 个字符视为空摘要（保守下限，宁失败不写垃圾 boundary）。 */
export const COMPACTION_SUMMARY_MIN_CHARS = 8;
/** 摘要文本上限：超出视为异常输出（provider 复读/注入），不落进 boundary。 */
export const COMPACTION_SUMMARY_MAX_CHARS = 200_000;

/** 同一 worker 已有在飞 attempt（或 sidecar 仍为 compacting）。 */
export class CompactionBusyError extends Error {
  readonly code = "compaction_busy";
  readonly attemptId: string | null;

  constructor(attemptId: string | null = null) {
    super(
      attemptId === null
        ? "compaction worker is busy"
        : `compaction worker is busy (attempt ${attemptId})`,
    );
    this.name = "CompactionBusyError";
    this.attemptId = attemptId;
  }
}

/** 状态 sidecar 落盘失败（磁盘/权限/非法 state）。属于基础设施错误，`done` 会 reject。 */
export class CompactionStateWriteError extends Error {
  readonly action: string;

  constructor(action: string, cause: unknown) {
    super(`compaction state write failed during ${action}: ${errorMessage(cause)}`, { cause });
    this.name = "CompactionStateWriteError";
    this.action = action;
  }
}

/** `wait()` 在没有在飞 attempt 也没有历史 outcome 时抛出。 */
export class CompactionNotRunningError extends Error {
  constructor() {
    super("compaction worker has no attempt to wait for");
    this.name = "CompactionNotRunningError";
  }
}

/** 单次 summarize 请求超时；`kind: "timeout"` 被 P1 classifier 归为 transient。 */
export class CompactionRequestTimeoutError extends Error {
  readonly kind = "timeout" as const;

  constructor(timeoutMs: number) {
    super(`compaction request timed out after ${String(timeoutMs)}ms`);
    this.name = "CompactionRequestTimeoutError";
  }
}

/** 摘要输出未通过长度/形状校验；`kind: "terminal"` 保证不重试。 */
export class CompactionSummaryValidationError extends Error {
  readonly kind = "terminal" as const;

  constructor(message: string) {
    super(message);
    this.name = "CompactionSummaryValidationError";
  }
}

/** 用户 abort（或 provider 报 true user abort）；`kind: "abort"` 保证不重试。 */
export class CompactionAbortedError extends Error {
  readonly kind = "abort" as const;

  constructor(reason: string | null) {
    super(reason === null ? "compaction aborted" : `compaction aborted: ${reason}`);
    this.name = "CompactionAbortedError";
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const record = asRecord(error);
  const message = record?.["message"];
  if (typeof message === "string" && message.length > 0) return message;
  return String(error);
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error));
}
