/**
 * W11a3 task_fetch —— 子会话成果「取件」工具（读侧速行版）。
 *
 * 一句话职责：主会话模型持 task 回灌 `<task_metadata>` 里的 session_id，按 sid 从注入的
 * 转录库（boot 的 state/session/loom-sessions.jsonl JsonlSessionStore 实例，切片0 a721b6d
 * 落盘面）只读拉回子/副会话成果。三档模式：
 *   - full ：全部 message 条目逐条渲染 "role: 文本 / toolCall(名+紧凑参数略截) /
 *            toolResult(名+输出略截)"（thinking 块按略截文本入列，非对话型 entry 只计数不渲染）；
 *   - clean：仅 user/assistant 文本（剔 toolCall / thinking 块与 toolResult 条目）；
 *   - tail ：clean 取末 count 条（缺省 8）。
 * 头部状态行恒为首行："sid 存在|不存在；条目数 N"——归属判定 = store.getLeafId 非空，
 * N = getPathToLeaf 全链 entry 数（含 terminal/compaction_boundary，投影只取 message 类）。
 * max_chars（缺省 24000）超限截断正文并追加标记行；头部行受保护不被截掉。
 *
 * 只读纪律（硬）：只用 SessionStore 的 getLeafId / getPathToLeaf 两个读方法；绝不
 * appendEntry / fork，绝不改动取回对象（协议不可变契约，投影按只读消费）。
 *
 * 语义钉死（勿在实现层漂移）：**这是读侧速行版**——task 现仍同步回摘要；W9 内核切片
 * 落地后 task 后台化（派发即返 sid）+ 本工具即成完整闭环，**工具接口不变**（参数名、
 * 三档模式、投影形状全部照旧，两侧无需任何适配）。
 */

import { Type } from "@axeuh/loom-core";
import type { TaskIndexPort } from "@axeuh/loom-core/kernel";
import type {
  HarnessTool,
  HookContext,
  Message,
  SessionStore,
  StoredEntry,
  ToolExecResult,
} from "@axeuh/loom-core";

import { plainInline } from "./text-utils.js";

export interface TaskFetchToolOptions {
  /**
   * 转录只读源：boot 注入 loom-sessions.jsonl 的 JsonlSessionStore 实例（协议面 =
   * SessionStore——单文件天然多 sid，主/副/子全可 fetch，子会话 fetch 兄弟会话合法）。
   */
  readonly store: SessionStore;
  /**
   * W9 切片 3（可选）：task_id→sid 双索引解析面（后台任务记账在 task_id 上）。
   * 缺省不接 = 旧调用面逐字节不变（非 ses_ 前缀仍抛旧句子）；接了 = `run_` 前缀寻址，
   * 输出带 task 状态头（`task <tid> status=<st> → sid <sid>；…`），正文同构。
   * 取件输出**不含** <task_metadata> 块（现状确认：纯文本状态头+转录投影，防 children 重帧）。
   */
  readonly taskIndex?: TaskIndexPort;
}

const MODES = ["full", "clean", "tail"] as const;
type Mode = (typeof MODES)[number];

/** 参数缺省三件套（任务冻结口径）。 */
const DEFAULT_MODE: Mode = "clean";
const DEFAULT_TAIL_COUNT = 8;
const DEFAULT_MAX_CHARS = 24_000;
/** full 档内嵌略截宽度：防单块巨型输出挤掉其余条目（总闸仍由 max_chars 收口）。 */
const INNER_TRUNC = 500;
const INNER_TRUNC_ARGS = 300;

/** 装配 task_fetch 工具（纯工厂：无 I/O 副作用，store 只读消费）。 */
export function createTaskFetchTool(opts: TaskFetchToolOptions): HarnessTool {
  return {
    name: "task_fetch",
    description:
      "Fetch a sub-agent / side session transcript by its session id " +
      "(the session_id inside <task_metadata>). Modes: full = every message entry rendered " +
      "(text / toolCall(name+truncated args) / toolResult(name+truncated output)); " +
      "clean = user/assistant text only (default); tail = last `count` clean entries (default 8). " +
      "Read-only. Output starts with a status line 'sid exists/absent; entry count N' " +
      "and is capped by max_chars (default 24000, overflow truncated with a marker line).",
    parameters: Type.Object({
      session_id: Type.String({
        description:
          opts.taskIndex === undefined
            ? "Target session id; must start with 'ses_' (e.g. <task_metadata> session_id)."
            : "Target session id ('ses_…') or background task id ('run_…', from task(background=true) status block / <task_metadata> task_id).",
        pattern: opts.taskIndex === undefined ? "^ses_" : "^(?:ses|run)_",
      }),
      mode: Type.Optional(
        Type.Union([Type.Literal("full"), Type.Literal("clean"), Type.Literal("tail")], {
          description: "Projection mode (default 'clean').",
        }),
      ),
      count: Type.Optional(
        Type.Number({ description: "tail mode only: keep the last N projected entries (default 8)." }),
      ),
      max_chars: Type.Optional(
        Type.Number({ description: "Output hard cap in characters (default 24000); overflow gets a truncation marker line." }),
      ),
    }),
    isReadOnly: true,
    isConcurrencySafe: () => true,

    async execute(args: Record<string, unknown>, _ctx: HookContext, _signal: AbortSignal): Promise<ToolExecResult> {
      const argId = typeof args.session_id === "string" ? args.session_id : "";
      // 双保险：schema pattern 之外，execute 入口再自校验（直调/别名通路不吃 schema）。
      // W9 切片 3：run_ 前缀=task_id 双索引（仅接线后放行；未接=旧句子逐字节不变）。
      let sessionId = argId;
      let taskHeader = "";
      if (!argId.startsWith("ses_")) {
        const isTaskId = argId.startsWith("run_") && opts.taskIndex !== undefined;
        if (!isTaskId) {
          throw new Error(`task_fetch: session_id must start with "ses_" (got "${argId.slice(0, 40)}")`);
        }
        const resolved = opts.taskIndex!.resolve(argId);
        if (resolved === undefined) {
          return textOnly(`task ${argId} 不存在（后台任务账本无此条；task_id 来自 task(background=true) 的状态块）`);
        }
        taskHeader = `task ${argId} status=${resolved.status} → sid ${resolved.sessionId}；`;
        sessionId = resolved.sessionId;
      }
      const mode = parseMode(args.mode);
      const count = parsePositiveInt(args.count, DEFAULT_TAIL_COUNT, "count");
      const maxChars = parsePositiveInt(args.max_chars, DEFAULT_MAX_CHARS, "max_chars");

      // 归属判定 + 全链条目（只读两方法，见模块头只读纪律）。
      const exists = (await opts.store.getLeafId(sessionId)) !== null;
      const path: StoredEntry[] = exists ? await opts.store.getPathToLeaf(sessionId) : [];
      const header = `${taskHeader}sid ${exists ? "存在" : "不存在"}；条目数 ${path.length}`;
      if (!exists) {
        return textOnly(
          `${header}\n\n(会话 ${sessionId} 在本转录库无任何条目；确认 sid 来自 <task_metadata> 的 session_id 或 /runs 视图)`,
        );
      }

      const messages = messagesOf(path);
      const lines =
        mode === "full"
          ? messages.map(renderFullMessage)
          : messages.map(renderCleanMessage).filter((l): l is string => l !== null);
      const kept = mode === "tail" ? lines.slice(Math.max(0, lines.length - count)) : lines;
      const body = kept.join("\n\n");

      // 截断口径：头部恒保留，正文按 max_chars 预算收口，超限追加标记行。
      const head = `${header}\n\n`;
      const budget = Math.max(maxChars - head.length, 0);
      const text =
        body.length <= budget
          ? head + (body === "" ? "(无符合该投影形态的正文条目)" : body)
          : head + body.slice(0, budget) +
              `\n[task_fetch: 输出超 max_chars=${maxChars}，正文已截断，省略 ${body.length - budget} 字符]`;
      return textOnly(text);
    },
  };
}

/* ───────────────────────── 参数解析（fail-loud：坏参数绝不静默吞） ───────────────────────── */

function parseMode(raw: unknown): Mode {
  if (raw === undefined) return DEFAULT_MODE;
  if (typeof raw === "string" && (MODES as readonly string[]).includes(raw)) return raw as Mode;
  throw new Error(`task_fetch: mode must be one of full|clean|tail (got ${JSON.stringify(raw)})`);
}

function parsePositiveInt(raw: unknown, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) {
    throw new Error(`task_fetch: ${name} must be a finite number >= 1 (got ${JSON.stringify(raw)})`);
  }
  return Math.min(Math.floor(raw), 1_000_000);
}

/* ───────────────────────── 投影渲染（三档共用底座） ───────────────────────── */

/** 只取 message 类条目（terminal/compaction_boundary 计数不渲染——与 history 读侧同口径）。 */
function messagesOf(path: readonly StoredEntry[]): Message[] {
  const out: Message[] = [];
  for (const stored of path) {
    if (stored.entry.kind === "message") out.push(stored.entry.message);
  }
  return out;
}

/** user 文本：string 内容原样；块数组只取 text 块，image 块打占位。 */
function userText(m: Extract<Message, { role: "user" }>): string {
  if (typeof m.content === "string") return m.content;
  const parts: string[] = [];
  for (const b of m.content) {
    if (b.type === "text") parts.push(b.text);
    else parts.push("[image omitted]");
  }
  return parts.join(" ");
}

/** full 档：逐条 "role: 文本 / toolCall(名+紧凑参数略截) / toolResult(名+输出略截)"。 */
function renderFullMessage(m: Message): string {
  if (m.role === "user") return `user: ${userText(m)}`;
  if (m.role === "assistant") {
    const segments: string[] = [];
    for (const b of m.content) {
      if (b.type === "text") segments.push(b.text);
      else if (b.type === "thinking") segments.push(`(thinking) ${truncate(b.thinking, INNER_TRUNC)}`);
      else segments.push(`toolCall ${b.name}(${argsToText(b.arguments)})`);
    }
    return `assistant: ${segments.join(" | ")}`;
  }
  const outText = m.content
    .map((b) => (b.type === "text" ? b.text : "[image omitted]"))
    .join(" ");
  return `toolResult ${m.toolName}: ${truncate(outText, INNER_TRUNC)}`;
}

/**
 * clean 档：仅 user/assistant 文本。assistant 剔 toolCall/thinking 块；文本为空则整条剔除；
 * toolResult 条目整条剔除（任务冻结口径）。
 */
function renderCleanMessage(m: Message): string | null {
  let text = "";
  if (m.role === "user") text = userText(m);
  else if (m.role === "assistant") {
    const parts: string[] = [];
    for (const b of m.content) if (b.type === "text") parts.push(b.text);
    text = parts.join("");
  } else return null;
  return text.trim() === "" ? null : `${m.role}: ${text}`;
}

function argsToText(args: Record<string, unknown>): string {
  let text: string;
  try {
    text = Object.entries(args)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${argValue(value)}`)
      .join("; ");
  } catch {
    text = String(args);
  }
  return truncate(text, INNER_TRUNC_ARGS);
}

function argValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => argValue(item)).join(",");
  }
  if (isPlainObject(value)) {
    return `(${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => `${key}=${argValue(entry)}`)
      .join(", ")})`;
  }
  return plainInline(String(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function truncate(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}…(+${text.length - cap})` : text;
}

function textOnly(text: string): ToolExecResult {
  return { content: [{ type: "text", text }] };
}
