/**
 * W13 上下文预览 —— 装配快照 → 分段构成清单（GET /sessions/:id/context 的纯逻辑层）。
 *
 * 真源 = 最近一次 Assembly 对象（loop.events() 的 assembly 记录，与 assembly-trace
 * 消费同一事件；本模块不新造数据源）。拆解口径：
 *   - system 段 → 系统提示（身份框）一行；
 *   - memory 段 → 按 `### memory[i] <source>` 标题拆每源一行（文件路径 = source）；
 *   - workflow 段 → 按 `## workflow <name>` 标题拆每模板一行；
 *   - increment 段 → 按行前缀拆 history+/nudge/reminder/user 四类易变槽。
 * 每行给行数（非空行，与 assembly trace attrs.injectedLines 同口径）、UTF-8 字节数、
 * token 粗估（bytes / 3.5，非精确 tokenizer）；降级源经 Assembly.degrades 标注原因。
 *
 * 副会话（无内存快照）走 trace 反推：当日 assembly span attrs.injectedLines +
 * sessionStore 转录行数——字节/估算 token 不可得，如实给 null（不伪造数值）。
 */

import type { Assembly, AssemblyDegrade } from "@axeuh/loom-core/assembly";

/** token 粗估系数（字节 / 系数；口径只此一处，前端同步展示）。 */
export const TOKEN_ESTIMATE_DIVISOR = 3.5;

/** 构成清单一行（段名 + 来源 + 体量）。 */
export interface ContextRow {
  /** 装配段：system / memory / workflow / increment。 */
  readonly segment: "system" | "memory" | "workflow" | "increment";
  /** 展示用段名（系统提示（身份框）/ memory 注入 / 工作流模板 / 历史增量 / nudge 槽 / reminder 槽 / 本轮消息）。 */
  readonly label: string;
  /** 文件路径或来源标识（memory = 注入源路径；increment = 行前缀来源）。 */
  readonly source: string;
  /** 非空行数；trace 反推不可得时 null。 */
  readonly lines: number | null;
  /** UTF-8 字节数；trace 反推不可得时 null。 */
  readonly bytes: number | null;
  /** token 粗估 = bytes / 3.5 四舍五入；trace 反推不可得时 null。 */
  readonly estimatedTokens: number | null;
  /** 降级原因（missing/unreadable/invalid）；无降级 null。 */
  readonly degraded: string | null;
}

/** GET /sessions/:id/context 响应体。 */
export interface ContextView {
  readonly sessionID: string;
  /** assembly = 内存快照（主会话最近一次装配）；trace = 当日 assembly span 反推（副会话）。 */
  readonly basis: "assembly" | "trace";
  /** 快照时刻（epoch ms；trace 取 span.end）。 */
  readonly capturedAt: number;
  /** 装配对应的 turn 序号；trace 反推不可得时 null。 */
  readonly turnIdx: number | null;
  readonly rows: readonly ContextRow[];
  readonly totalBytes: number | null;
  readonly totalLines: number | null;
  readonly estimatedTokens: number | null;
  /** 模型上下文窗口（token）；模型未带时 null。 */
  readonly contextWindow: number | null;
  /** estimatedTokens / contextWindow；任一缺失 null。 */
  readonly usageRatio: number | null;
  /** 口径与新鲜度说明（粗估标注、内存快照重启清空等）。 */
  readonly note: string;
}

/** 与 assembly trace attrs.injectedLines 同口径：非空行数。 */
function nonEmptyLines(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) {
    if (line.trim() !== "") n += 1;
  }
  return n;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** token 粗估（bytes / 3.5）；bytes 缺失返回 null。 */
export function estimateTokens(bytes: number | null): number | null {
  return bytes === null ? null : Math.round(bytes / TOKEN_ESTIMATE_DIVISOR);
}

/** 按行首标题拆条目（返回条目原文含标题行；拼接即整段）。 */
function splitEntries(text: string, titleRe: RegExp): Array<{ title: string; text: string }> {
  const out: Array<{ title: string; text: string }> = [];
  const re = new RegExp(titleRe.source, "gm");
  let match: RegExpExecArray | null = null;
  let start = -1;
  let title = "";
  while ((match = re.exec(text)) !== null) {
    if (start >= 0) out.push({ title, text: text.slice(start, match.index) });
    start = match.index;
    title = match[1] ?? "";
  }
  if (start >= 0) out.push({ title, text: text.slice(start) });
  return out;
}

function degradeOf(degrades: readonly AssemblyDegrade[], segment: string, source: string): string | null {
  const hit = degrades.find((d) => d.segment === segment && d.source === source);
  return hit === undefined ? null : hit.reason;
}

/** memory 段一行（源路径来自 `### memory[i] <source>` 标题）。 */
function memoryRow(entry: { title: string; text: string }, degrades: readonly AssemblyDegrade[]): ContextRow {
  const bytes = byteLength(entry.text);
  return {
    segment: "memory",
    label: "memory 注入",
    source: entry.title,
    lines: nonEmptyLines(entry.text),
    bytes,
    estimatedTokens: estimateTokens(bytes),
    degraded: degradeOf(degrades, "memory", entry.title),
  };
}

function workflowRow(entry: { title: string; text: string }, degrades: readonly AssemblyDegrade[]): ContextRow {
  const bytes = byteLength(entry.text);
  return {
    segment: "workflow",
    label: "工作流模板",
    source: entry.title,
    lines: nonEmptyLines(entry.text),
    bytes,
    estimatedTokens: estimateTokens(bytes),
    degraded: degradeOf(degrades, "workflow", entry.title),
  };
}

const INCREMENT_PREFIXES: ReadonlyArray<{ prefix: string; segment: ContextRow["segment"]; label: string; source: string }> = [
  { prefix: "history+ ", segment: "increment", label: "历史增量", source: "history+（装配增量行）" },
  { prefix: "nudge: ", segment: "increment", label: "nudge 槽", source: "nudge（催办注入）" },
  { prefix: "reminder: ", segment: "increment", label: "reminder 槽", source: "reminder（W12 提醒）" },
  { prefix: "user: ", segment: "increment", label: "本轮消息", source: "user（本轮用户消息）" },
];

/** increment 段拆易变槽：按行前缀归桶，续行（多行消息）归前一桶。 */
function incrementRows(text: string, degrades: readonly AssemblyDegrade[]): ContextRow[] {
  const buckets = new Map<number, { lines: number; bytes: number }>();
  let current = -1;
  for (const line of text.split("\n")) {
    const idx = INCREMENT_PREFIXES.findIndex((p) => line.startsWith(p.prefix));
    if (idx >= 0) current = idx;
    if (current < 0 || line === "") continue;
    const bucket = buckets.get(current) ?? { lines: 0, bytes: 0 };
    if (line.trim() !== "") bucket.lines += 1;
    bucket.bytes += byteLength(line) + 1; // +1 = 行尾 \n（装配格式每行带换行）
    buckets.set(current, bucket);
  }
  const historyDegrade = degradeOf(degrades, "increment", "history");
  const rows: ContextRow[] = [];
  for (const [idx, meta] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const def = INCREMENT_PREFIXES[idx]!;
    rows.push({
      segment: def.segment,
      label: def.label,
      source: def.source,
      lines: meta.lines,
      bytes: meta.bytes,
      estimatedTokens: estimateTokens(meta.bytes),
      degraded: def.prefix === "history+ " ? historyDegrade : null,
    });
  }
  return rows;
}

const CONTEXT_NOTE =
  "token 为粗估（UTF-8 字节 / 3.5，非 tokenizer 精算）；行数 = 非空行（与 assembly trace attrs.injectedLines 同口径）；" +
  "快照 = 该会话最近一次装配（仅内存，服务重启清空）。";

/** Assembly → 分段构成清单（纯函数；测试直接钉形状）。 */
export function buildContextView(opts: {
  readonly sessionID: string;
  readonly assembly: Assembly;
  readonly turnIdx: number | null;
  readonly capturedAt: number;
  readonly contextWindow: number | null;
}): ContextView {
  const { assembly } = opts;
  const bySegment = new Map(assembly.segments.map((s) => [s.name, s] as const));
  const rows: ContextRow[] = [];

  const system = bySegment.get("system");
  if (system !== undefined && system.bytes.byteLength > 0) {
    const text = new TextDecoder().decode(system.bytes);
    rows.push({
      segment: "system",
      label: "系统提示（身份框）",
      source: "systemPrompt",
      lines: nonEmptyLines(text),
      bytes: system.bytes.byteLength,
      estimatedTokens: estimateTokens(system.bytes.byteLength),
      degraded: degradeOf(assembly.degrades, "system", "systemPrompt"),
    });
  }

  const memory = bySegment.get("memory");
  if (memory !== undefined && memory.bytes.byteLength > 0) {
    for (const entry of splitEntries(new TextDecoder().decode(memory.bytes), /^### memory\[\d+\] (.+)$/)) {
      rows.push(memoryRow(entry, assembly.degrades));
    }
  }

  const workflow = bySegment.get("workflow");
  if (workflow !== undefined && workflow.bytes.byteLength > 0) {
    for (const entry of splitEntries(new TextDecoder().decode(workflow.bytes), /^## workflow (.+)$/)) {
      rows.push(workflowRow(entry, assembly.degrades));
    }
  }

  const increment = bySegment.get("increment");
  if (increment !== undefined && increment.bytes.byteLength > 0) {
    rows.push(...incrementRows(new TextDecoder().decode(increment.bytes), assembly.degrades));
  }

  const totalBytes = assembly.segments.reduce((n, s) => n + s.bytes.byteLength, 0);
  const totalLines = rows.reduce((n, r) => n + (r.lines ?? 0), 0);
  const estimatedTokens = estimateTokens(totalBytes);
  return {
    sessionID: opts.sessionID,
    basis: "assembly",
    capturedAt: opts.capturedAt,
    turnIdx: opts.turnIdx,
    rows,
    totalBytes,
    totalLines,
    estimatedTokens,
    contextWindow: opts.contextWindow,
    usageRatio:
      estimatedTokens !== null && opts.contextWindow !== null && opts.contextWindow > 0
        ? estimatedTokens / opts.contextWindow
        : null,
    note: CONTEXT_NOTE,
  };
}

/**
 * 副会话（无内存快照）从当日 trace assembly span + sessionStore 行数反推：
 * 字节/估算 token 不可得如实 null；仅行数（injectedLines + 转录消息条数）可查。
 */
export function buildTraceContextView(opts: {
  readonly sessionID: string;
  readonly capturedAt: number;
  readonly injectedLines: number;
  readonly memorySourceCount: number;
  readonly historyRows: number | null;
  readonly contextWindow: number | null;
}): ContextView {
  const rows: ContextRow[] = [
    {
      segment: "memory",
      label: "memory 注入",
      source: `trace assembly span 反推（清单 ${String(opts.memorySourceCount)} 条）`,
      lines: opts.injectedLines,
      bytes: null,
      estimatedTokens: null,
      degraded: null,
    },
    {
      segment: "increment",
      label: "历史增量",
      source: "sessionStore 转录消息条数",
      lines: opts.historyRows,
      bytes: null,
      estimatedTokens: null,
      degraded: null,
    },
  ];
  return {
    sessionID: opts.sessionID,
    basis: "trace",
    capturedAt: opts.capturedAt,
    turnIdx: null,
    rows,
    totalBytes: null,
    totalLines: (opts.injectedLines ?? 0) + (opts.historyRows ?? 0),
    estimatedTokens: null,
    contextWindow: opts.contextWindow,
    usageRatio: null,
    note:
      "副会话快照从当日 trace 的 assembly span 反推（字节与估算 token 不可得，仅行数）；" +
      "装配快照本体不落盘，主会话内存快照在服务重启后清空。",
  };
}
