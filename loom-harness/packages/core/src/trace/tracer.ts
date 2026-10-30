/**
 * T21 Tracer / RunTracker —— span 骨架写入 `{stateRoot}/trace/{date}.jsonl`。
 *
 * 写侧契约：
 *   - 每行一条 JSON（JSONL），只追加、从不改写（append-only）。
 *   - 日期分文件按 run 开始时刻的本地日期（`YYYY-MM-DD`）切。
 *   - span 生命周期 open→close 在内存配对，close 成功才落一整行完整 span
 *     （start/end/durationMs 恒在，避免半行）。
 *   - 单行单次 `appendFileSync`；进程级撕裂（崩溃切行）由读侧
 *     `readTraceFile` 跳过坏行容忍。
 *
 * TODO(T08/T39 切换点)：T08 Journal 并行开发中，届时把 `Tracer.emit` 的
 * fs append 换成 Journal 统一 append 通道即可——除本方法外无人依赖 fs 细节。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { SPAN_STAGES } from "./types.js";
import type {
  CloseSpanAttrs,
  OpenSpanAttrs,
  RunMeta,
  RunSpan,
  RunStatus,
  SpanAttrValue,
  SpanStage,
  TraceNudge,
  TraceRecord,
  TraceRunEnd,
} from "./types.js";

/** 时钟注入（测试确定性用）；默认 `Date.now`。 */
export type Clock = () => number;

export interface TracerOptions {
  /**
   * harness state 根目录（内含 `trace/` 子目录）。根路径参数注入、禁硬编码；
   * 默认 "state" 相对 cwd 解析——仓库根运行即 harness 的 `state/trace/`。
   */
  readonly stateRoot?: string;
  readonly clock?: Clock;
  /** 日期键覆盖（仅测试用；默认取 run 开始时刻的本地日期 YYYY-MM-DD）。 */
  readonly dateKey?: string;
}

/** openSpan 入参：OpenSpanAttrs 之外可显式指定骨架 stage。 */
export interface OpenSpanInput extends OpenSpanAttrs {
  readonly stage?: SpanStage;
}

const DEFAULT_STATE_ROOT = "state";

/** 生成 `[a-z前缀]_<hex16>` 无连字符 id（Open Questions 裁决2 / D34）。 */
function makeId(prefix: "run" | "spn"): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/** 本地日期键 YYYY-MM-DD（日期分文件依据）。 */
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 用法错误：未知 spanId、run 收尾后继续写、id 含连字符。 */
export class TraceError extends Error {
  override readonly name = "TraceError";
}

/** open 后待 close 的 span 现场。 */
interface OpenSpanSite {
  readonly spanId: string;
  readonly stage: SpanStage;
  readonly start: number;
  readonly open: OpenSpanInput;
}

/**
 * 一次 run 的轨迹跟踪器。由 `Tracer.startRun` 创建；
 * 构造签名虽公开（类型可见性），调用方一律走 startRun，保证时钟/落盘通道统一。
 */
export class RunTracker {
  readonly runId: string;
  private readonly tracer: Tracer;
  private readonly meta: RunMeta;
  private readonly startedAt: number;
  private readonly dateKey: string;
  private readonly openSites = new Map<string, OpenSpanSite>();
  private readonly closedSpans: RunSpan[] = [];
  private finished = false;

  /** 仅供 Tracer.startRun 调用。 */
  constructor(tracer: Tracer, meta: RunMeta, runId: string, startedAt: number, dateKey: string) {
    this.tracer = tracer;
    this.meta = meta;
    this.runId = runId;
    this.startedAt = startedAt;
    this.dateKey = dateKey;
  }

  /** 打开一个 span，返回无连字符 spanId；start 记此刻。stage 缺省按名字推断。 */
  openSpan(name: string, attrs?: OpenSpanInput): string {
    this.assertAlive();
    const spanId = makeId("spn");
    const stage: SpanStage = attrs?.stage ?? inferStage(name);
    this.openSites.set(spanId, { spanId, stage, start: this.tracer.now(), open: attrs ?? { stage } });
    return spanId;
  }

  /** 关闭 span：合并 open/close 属性，整行 JSONL 落盘。未知 id 抛错（配对契约）。 */
  closeSpan(id: string, attrs?: CloseSpanAttrs): void {
    this.assertAlive();
    const site = this.openSites.get(id);
    if (site === undefined) {
      throw new TraceError(`closeSpan: 未知 spanId ${id}（未 open 或已 close）`);
    }
    this.openSites.delete(id);
    const end = this.tracer.now();
    const span = mergeSpan(site, end, attrs, this.runId, this.meta.sessionId);
    this.closedSpans.push(span);
    this.tracer.emit(this.dateKey, span);
  }

  /** 记一条 nudge 事件行（即时事件，不占 span 生命周期）。 */
  nudge(event: string, opts?: { readonly spanId?: string; readonly detail?: string }): void {
    this.assertAlive();
    const rec: TraceNudge = {
      kind: "nudge",
      runId: this.runId,
      event,
      at: this.tracer.now(),
      ...(opts?.spanId !== undefined ? { spanId: opts.spanId } : {}),
      ...(opts?.detail !== undefined ? { detail: opts.detail } : {}),
    };
    this.tracer.emit(this.dateKey, rec);
  }

  /**
   * 收尾：写 run_end 聚合行（token totals + span 数 + 终态）；此后任何写方法抛错。
   * W16-F4：`usage` = run 的**实测终局**（引擎登记面自内核 RunSummary 透传）——在场即 totals
   * 真源；缺席回落 span 累加（簿记面从未 close 过 span 的现网形态下累加恒 0，不可当真相）。
   */
  finishRun(
    status: RunStatus,
    usage?: { readonly input: number; readonly output: number; readonly cacheRead: number },
  ): TraceRunEnd {
    this.assertAlive();
    this.finished = true;
    const endedAt = this.tracer.now();
    const totals = usage ?? sumTokens(this.closedSpans);
    const rec: TraceRunEnd = {
      kind: "run_end",
      runId: this.runId,
      ...(this.meta.sessionId !== undefined ? { sessionId: this.meta.sessionId } : {}),
      ...(this.meta.workflow !== undefined ? { workflow: this.meta.workflow } : {}),
      status,
      startedAt: this.startedAt,
      endedAt,
      durationMs: endedAt - this.startedAt,
      totals: { input: totals.input, output: totals.output, cacheRead: totals.cacheRead, spans: this.closedSpans.length },
    };
    this.tracer.emit(this.dateKey, rec);
    return rec;
  }

  /** 已 close 的 span（只读快照，聚合/断言用）。 */
  get spans(): readonly RunSpan[] {
    return this.closedSpans;
  }

  private assertAlive(): void {
    if (this.finished) {
      throw new TraceError(`run ${this.runId} 已 finishRun，拒绝后续写入`);
    }
  }
}

/**
 * trace 写入器。`startRun(meta) -> RunTracker`。
 * 落盘路径：`{stateRoot}/trace/{YYYY-MM-DD}.jsonl`。
 */
export class Tracer {
  private readonly dirPath: string;
  private readonly clock: Clock;
  private readonly dateKeyOverride: string | undefined;
  private dirReady = false;

  constructor(opts: TracerOptions = {}) {
    // 根路径参数注入（禁硬编码）：显式 stateRoot > LOOM_STATE 环境变量 > "state"（相对 cwd）。
    this.dirPath = join(opts.stateRoot ?? process.env["LOOM_STATE"] ?? DEFAULT_STATE_ROOT, "trace");
    this.clock = opts.clock ?? (() => Date.now());
    this.dateKeyOverride = opts.dateKey;
  }

  /** trace 目录（只读访问器，测试/运维定位文件用）。 */
  get traceDir(): string {
    return this.dirPath;
  }

  /** 当前时钟读数。 */
  now(): number {
    return this.clock();
  }

  /** 开启一次 run。runId 省略则自动生成；显式传入含连字符则拒绝（D34 白名单）。 */
  startRun(meta: RunMeta = {}): RunTracker {
    const runId = meta.runId ?? makeId("run");
    if (runId.includes("-")) {
      throw new TraceError(`runId 禁含连字符（D34 id 白名单）：${runId}`);
    }
    const startedAt = this.now();
    const dateKey = this.dateKeyOverride ?? localDateKey(startedAt);
    return new RunTracker(this, meta, runId, startedAt, dateKey);
  }

  /** 追加一行 JSONL（目录惰性创建一次）。TODO(T08)：Journal 落地后此处切换为其统一 append 通道。 */
  emit(dateKey: string, rec: TraceRecord): void {
    if (!this.dirReady) {
      mkdirSync(this.dirPath, { recursive: true });
      this.dirReady = true;
    }
    appendFileSync(join(this.dirPath, `${dateKey}.jsonl`), `${JSON.stringify(rec)}\n`, "utf8");
  }
}

// openSpan 未显式给 stage 时，按骨架词表（queued→…→delivered）从名字推断。
function inferStage(name: string): SpanStage {
  const lower = name.toLowerCase();
  for (const stage of SPAN_STAGES) {
    if (lower.includes(stage)) return stage;
  }
  return "turn";
}

// close 落盘行字段合并：open 侧给结构（stage/parent/index/name），close 侧给结果（tokens 等）。
function mergeSpan(
  site: OpenSpanSite,
  end: number,
  attrs: CloseSpanAttrs | undefined,
  runId: string,
  sessionId: string | undefined,
): RunSpan {
  const name = attrs?.name ?? site.open.name ?? site.stage;
  const index = attrs?.index ?? site.open.index;
  const parentSpanId = attrs?.parentSpanId ?? site.open.parentSpanId;
  const mergedAttrs: Record<string, SpanAttrValue> = { ...site.open.attrs, ...attrs?.attrs };
  return {
    kind: "span",
    runId,
    ...(sessionId !== undefined ? { sessionId } : {}),
    spanId: site.spanId,
    ...(parentSpanId !== undefined ? { parentSpanId } : {}),
    stage: site.stage,
    name,
    ...(index !== undefined ? { index } : {}),
    start: site.start,
    end,
    durationMs: end - site.start,
    ...(attrs?.tokens !== undefined ? { tokens: attrs.tokens } : {}),
    ...(attrs?.model !== undefined ? { model: attrs.model } : {}),
    ...(attrs?.failure !== undefined ? { failure: attrs.failure } : {}),
    ...(attrs?.retry !== undefined ? { retry: attrs.retry } : {}),
    ...(attrs?.assemblyRowCount !== undefined ? { assemblyRowCount: attrs.assemblyRowCount } : {}),
    ...(Object.keys(mergedAttrs).length > 0 ? { attrs: mergedAttrs } : {}),
  };
}

// run_end token 合计：只累加已 close 的 span（未 close 视为调用方泄漏，由自检负责）。
function sumTokens(spans: readonly RunSpan[]): { input: number; output: number; cacheRead: number } {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  for (const s of spans) {
    input += s.tokens?.input ?? 0;
    output += s.tokens?.output ?? 0;
    cacheRead += s.tokens?.cacheRead ?? 0;
  }
  return { input, output, cacheRead };
}
