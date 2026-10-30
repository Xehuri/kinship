/**
 * W57 压缩重试策略（P1 核心原语）。
 *
 * 对齐 opencode 的 provider 重试：2s 起、×2、±25% 抖动、单次等待硬顶 30s；
 * Retry-After 同样受 30s 硬顶。预算在**一次 compaction attempt 内**共享，
 * 耗尽即转 retry_pending，绝不跨 attempt 重置。
 *
 * 分类只依赖结构化字段与错误文案，不 import provider SDK：worker 对同步建流错误
 * 标 `phase: "stream_create"`（或 `kind: "sync"`），其余按 HTTP 状态/错误码/文案判定。
 * 默认未知错误 = terminal，避免对配置/鉴权错误做无意义重试。
 */

export const COMPACTION_MAX_RETRIES = 10;
export const COMPACTION_RETRY_BASE_MS = 2_000;
export const COMPACTION_RETRY_FACTOR = 2;
export const COMPACTION_RETRY_JITTER_RATIO = 0.25;
export const COMPACTION_RETRY_MAX_DELAY_MS = 30_000;

export type CompactionErrorClass = "transient" | "overflow" | "sync" | "abort" | "terminal";

const KIND_TO_CLASS: Readonly<Record<string, CompactionErrorClass>> = {
  abort: "abort",
  overflow: "overflow",
  sync: "sync",
  transient: "transient",
  terminal: "terminal",
  timeout: "transient",
  rate_limit: "transient",
};

const OVERFLOW_NAMES = ["ContextOverflowError", "OverflowError"];
const SYNC_NAMES = ["StreamCreationError", "StreamCreateError"];
const TIMEOUT_CODES = ["ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"];
const SYNC_CODES = ["STREAM_CREATE", "STREAM_CREATION_ERROR", "ERR_STREAM_CREATE"];
const OVERFLOW_CODES = ["CONTEXT_OVERFLOW", "CONTEXT_LENGTH_EXCEEDED", "TOKEN_LIMIT_EXCEEDED"];
const TRANSIENT_CODES = [
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_BODY_TIMEOUT",
  "ERR_NETWORK",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
];

const RATE_LIMIT_RE = /rate[\s_-]?limit|too many requests|throttl|resource[ _-]?exhausted|quota (?:exceeded|exhausted)|overloaded|temporarily unavailable/i;
const TIMEOUT_RE = /\btimed?\s*out\b|\btimeout\b|deadline exceeded|etimedout/i;
const ABORT_RE = /\babort(?:ed)?\s+by\s+user\b|\buser\s+abort(?:ed)?\b|\bcancel(?:l)?ed\s+by\s+user\b/i;
const NETWORK_RE = /socket hang up|connection (?:reset|refused|closed|terminated|aborted)|aborted\s+by\s+peer|other side closed|network (?:error|failure|unreachable)|fetch failed|upstream (?:connect|request)|bad gateway|service unavailable|gateway timeout|econnreset|eai_again|enotfound/i;
const STREAM_CREATE_RE = /(?:failed to|failure to|could not|unable to)\s+(?:create|open|start)\s+(?:the\s+)?stream|stream (?:creation|create)\s+(?:failed|error)/i;
const STREAM_TRUNCATED_RE = /stream ended without finish_reason|unexpected end of (?:stream|response)|stream (?:closed|ended|terminated) before finish/i;
const HTTP_TRANSIENT_RE = /\b(?:408|425|429|5\d\d)\b/;
const OVERFLOW_RES: readonly RegExp[] = [
  /context[\s_-]*(?:length|window)/i,
  /(?:maximum|max)[\s_-]*(?:context|tokens?)/i,
  /maximum number of tokens/i,
  /(?:context|token)[\s_-]*(?:limit|overflow|exceeded)/i,
  /(?:prompt|input|request)[\s_-]+(?:is\s+)?too\s+(?:long|large)/i,
  /too many tokens/i,
  /range of input length/i,
  /reduce the length/i,
  /exceeds? the (?:maximum|model)/i,
];

function hasAny(values: readonly string[], expected: readonly string[]): boolean {
  return values.some((value) => expected.includes(value));
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function rootString(error: unknown, key: string): string | null {
  const value = asRecord(error)?.[key];
  return typeof value === "string" ? value : null;
}

function readStatus(record: Record<string, unknown>): number | null {
  for (const key of ["status", "statusCode", "httpStatus"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  const response = asRecord(record["response"]);
  if (response !== null) {
    const value = response["status"] ?? response["statusCode"];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

interface ErrorSignals {
  readonly names: readonly string[];
  readonly codes: readonly string[];
  readonly status: number | null;
  readonly text: string;
}

/** 收集 error 与一层 cause 的 name/code/status/message；避免依赖任何 SDK 类。 */
function collectSignals(error: unknown): ErrorSignals {
  const records: Array<Record<string, unknown>> = [];
  const root = asRecord(error);
  if (root !== null) {
    records.push(root);
    const cause = asRecord(root["cause"]);
    if (cause !== null) records.push(cause);
  }
  const names: string[] = [];
  const codes: string[] = [];
  const texts: string[] = typeof error === "string" ? [error] : [];
  let status: number | null = null;
  for (const record of records) {
    const name = record["name"];
    if (typeof name === "string") names.push(name);
    const code = record["code"];
    if (typeof code === "string") codes.push(code.toUpperCase());
    const text = record["message"] ?? record["errorMessage"] ?? record["detail"];
    if (typeof text === "string") texts.push(text);
    status ??= readStatus(record);
  }
  return { names, codes, status, text: texts.join(" | ") };
}

/**
 * 单次等待毫秒数。`attempt` 从 0 开始（第一次重试）；Retry-After 存在时优先且不加抖动。
 * `random` 可注入用于确定性测试，取值被夹到 [0, 1]。
 */
export function retryDelayMs(
  attempt: number,
  retryAfterMs?: number | null,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new RangeError(`retryDelayMs: attempt must be an integer >= 0 (got ${String(attempt)})`);
  }
  if (retryAfterMs !== undefined && retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(Math.round(retryAfterMs), COMPACTION_RETRY_MAX_DELAY_MS);
  }
  const base = Math.min(
    COMPACTION_RETRY_BASE_MS * COMPACTION_RETRY_FACTOR ** attempt,
    COMPACTION_RETRY_MAX_DELAY_MS,
  );
  const sample = random();
  const unit = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
  const jittered = base * (1 + (unit * 2 - 1) * COMPACTION_RETRY_JITTER_RATIO);
  return Math.max(0, Math.min(COMPACTION_RETRY_MAX_DELAY_MS, Math.round(jittered)));
}

/** 五类归因：transient 可重试；overflow/sync/abort/terminal 均不消耗预算。 */
export function classifyCompactionError(error: unknown): CompactionErrorClass {
  const kind = rootString(error, "kind");
  if (kind !== null && Object.hasOwn(KIND_TO_CLASS, kind)) {
    return KIND_TO_CLASS[kind] ?? "terminal";
  }
  const phase = rootString(error, "phase");
  if (phase === "stream_create" || phase === "stream-create" || phase === "sync") return "sync";
  if (rootString(error, "stopReason") === "length") return "overflow";

  const signals = collectSignals(error);
  if (hasAny(signals.names, OVERFLOW_NAMES)) return "overflow";
  if (hasAny(signals.names, SYNC_NAMES)) return "sync";
  if (signals.names.includes("TimeoutError")) return "transient";
  if (signals.names.includes("AbortError")) return "abort";
  if (hasAny(signals.codes, OVERFLOW_CODES)) return "overflow";
  if (hasAny(signals.codes, SYNC_CODES)) return "sync";
  if (signals.codes.includes("ABORT_ERR")) return "abort";
  if (hasAny(signals.codes, TIMEOUT_CODES) || hasAny(signals.codes, TRANSIENT_CODES)) return "transient";

  const status = signals.status;
  if (status !== null && (status === 408 || status === 425 || status === 429 || status >= 500)) {
    return "transient";
  }

  const text = signals.text;
  if (STREAM_CREATE_RE.test(text)) return "sync";
  if (RATE_LIMIT_RE.test(text) || HTTP_TRANSIENT_RE.test(text)) return "transient";
  if (TIMEOUT_RE.test(text)) return "transient";
  if (NETWORK_RE.test(text)) return "transient";
  if (STREAM_TRUNCATED_RE.test(text)) return "transient";
  if (ABORT_RE.test(text)) return "abort";
  if (matchesAny(text, OVERFLOW_RES)) return "overflow";
  return "terminal";
}

export interface CompactionRetryBudgetOptions {
  /** 缺省 COMPACTION_MAX_RETRIES；允许 per-instance 配置（生产由 config.retryCount 注入）。 */
  readonly maxRetries?: number;
}

/** 一次 compaction attempt 的重试预算：10 次重试 = 11 次总尝试。 */
export class CompactionRetryBudget {
  readonly #maxRetries: number;
  #used = 0;

  constructor(options: CompactionRetryBudgetOptions = {}) {
    const maxRetries = options.maxRetries ?? COMPACTION_MAX_RETRIES;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new RangeError(`CompactionRetryBudget: maxRetries must be an integer >= 0 (got ${String(maxRetries)})`);
    }
    this.#maxRetries = maxRetries;
  }

  get maxRetries(): number {
    return this.#maxRetries;
  }

  get used(): number {
    return this.#used;
  }

  get remaining(): number {
    return this.#maxRetries - this.#used;
  }

  canRetry(): boolean {
    return this.#used < this.#maxRetries;
  }

  /** 有余额则消耗一次并返回 true；耗尽返回 false（幂等，不增量）。 */
  consume(): boolean {
    if (!this.canRetry()) return false;
    this.#used += 1;
    return true;
  }
}
