/**
 * T21 trace/span 审计 —— JSONL 行 schema（类型化导出）。
 *
 * 设计依据：docs/02 §T21 + Open Questions 裁决2（无连字符 id）。
 * 消费方：T29（SSE fan-out 读今日 jsonl）、T39（shadow 验证聚合）。
 * 写侧只追加、从不改写；读侧对撕裂行容忍（见 reader.ts）。
 *
 * 一条 JSONL 行 = 一个 TraceRecord，按 `kind` 判别（span / nudge / run_end）。
 */

/** span 阶段骨架：queued→admitted→assembly→turn[i]→tool[j]→summary→delivered。 */
export const SPAN_STAGES = [
  "queued",
  "admitted",
  "assembly",
  "turn",
  "tool",
  "summary",
  "delivered",
] as const;
export type SpanStage = (typeof SPAN_STAGES)[number];

/** run 终态。 */
export type RunStatus = "ok" | "error" | "cancelled";

/** span 属性值的可序列化基元（禁 undefined，exactOptional 风格统一）。 */
export type SpanAttrValue = string | number | boolean | null;

/** token 计量：in / out / cache-read 命中。 */
export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
}

/** 模型引用：provider 必填（验收项"model provider"）。 */
export interface ModelRef {
  readonly provider: string;
  readonly modelId?: string;
}

/** 失败信息：reason 必填（验收项"failure reason"）。 */
export interface FailureInfo {
  readonly reason: string;
  readonly retryable?: boolean;
}

/** 重试信息：reason + 第几次尝试（验收项"retry reason"）。 */
export interface RetryInfo {
  readonly reason: string;
  readonly attempt: number;
}

/**
 * 一个已完成 span 的完整行。start/end/durationMs 恒在（验收项）。
 * D20 常量性证明：assembly span 携带 `assemblyRowCount`（本次装配读到的 L0 行数），
 * 前缀未变时两次 run 该值必须一致。
 */
export interface RunSpan {
  readonly kind: "span";
  readonly runId: string;
  readonly sessionId?: string;
  /** 无连字符 id：`spn_<hex16>`（D31/D34 前端约束同族）。 */
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly stage: SpanStage;
  /** 工具级粒度：tool span 记工具名；turn span 可记模型别名。 */
  readonly name?: string;
  /** turn[i] / tool[j] 的序号 i / j。 */
  readonly index?: number;
  /** epoch ms。 */
  readonly start: number;
  /** epoch ms。 */
  readonly end: number;
  readonly durationMs: number;
  readonly tokens?: TokenUsage;
  readonly model?: ModelRef;
  readonly failure?: FailureInfo;
  readonly retry?: RetryInfo;
  /** D20：assembly span 的装配行数；两次一致即常量性证明。 */
  readonly assemblyRowCount?: number;
  readonly attrs?: Readonly<Record<string, SpanAttrValue>>;
}

/** nudge 事件行（steering / 打桩推进等即时事件，不占 span 生命周期）。 */
export interface TraceNudge {
  readonly kind: "nudge";
  readonly runId: string;
  readonly event: string;
  readonly spanId?: string;
  readonly at: number;
  readonly detail?: string;
}

/** run 收尾行：聚合 token 合计与终态。 */
export interface TraceRunEnd {
  readonly kind: "run_end";
  readonly runId: string;
  readonly sessionId?: string;
  readonly workflow?: string;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly totals: TokenUsage & { readonly spans: number };
}

/** JSONL 一行的判别联合。 */
export type TraceRecord = RunSpan | TraceNudge | TraceRunEnd;

/** startRun 元数据。 */
export interface RunMeta {
  /** 省略则自动生成 `run_<hex16>`。 */
  readonly runId?: string;
  readonly sessionId?: string;
  readonly workflow?: string;
  readonly attrs?: Readonly<Record<string, SpanAttrValue>>;
}

/** openSpan 属性（可与 closeSpan 属性合并，close 侧覆盖 open 侧同名键）。 */
export interface OpenSpanAttrs {
  readonly parentSpanId?: string;
  readonly name?: string;
  readonly index?: number;
  readonly attrs?: Readonly<Record<string, SpanAttrValue>>;
}

/** closeSpan 属性。 */
export interface CloseSpanAttrs extends OpenSpanAttrs {
  readonly tokens?: TokenUsage;
  readonly model?: ModelRef;
  readonly failure?: FailureInfo;
  readonly retry?: RetryInfo;
  readonly assemblyRowCount?: number;
}

/** id 白名单正则：`[a-z][a-z0-9_]{2,4}_<hex16>`，连字符永久禁用（Open Questions 裁决2）。 */
export const TRACE_ID_PATTERN = /^[a-z][a-z0-9_]{2,4}_[0-9a-f]{16}$/;

/** 判别辅助：是否为 span 行。 */
export function isRunSpan(rec: TraceRecord): rec is RunSpan {
  return rec.kind === "span";
}
