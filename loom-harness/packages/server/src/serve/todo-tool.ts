/**
 * W11b todowrite —— 多步计划工具（todo.updated 事件的唯一发射源）。
 *
 * 一句话职责：模型提交**整表**计划清单，工具做三件事——
 *   1. 校验并归一 items（content/status/priority 三键，词表外值 fail-loud 抛错）；
 *   2. 写 per-session 存储（HookContext.state slot：每 AgentSession 独享一份 ctx，
 *      主/副/子会话天然隔离，子会话随 session 生命周期自然回收——registry #records
 *      方案需要动 SessionRecord 形状 + 工具反向持 registry，侵入更大，此为最小正解）；
 *   3. 经装配缝上抛（boot 接 registry.hubOf(sid)?.publish("todo.updated", sid, {todos})，
 *      帧 properties = { sessionID, todos } 对齐 mybot-web sse.js handleTodoUpdated
 *      的消费形状；文档 L293-308 样例只画 sessionID，todos 一键以前端消费真源为准）。
 *
 * 语义钉死（OMO/todowrite 惯例）：**整表替换**——每次调用上传完整清单即全量更新，
 * 没有增量 patch；改状态 = 重发整表。工具名取 `todowrite`：mybot-web 前端按
 * `part.tool === "todowrite"` 提取、EVENT_API_DOC 工具表同名录入（事件名 todo.updated
 * 与消费形状倒推工具名，opencode 真源亦此名）。
 *
 * 事件面纪律：sink 抛错**绝不**把成功执行翻成 isError（观测面 fail-soft，同 trace
 * wrapAll 口径），warn 留痕；无订阅者/子会话（未注册 registry，hubOf=undefined）时
 * publish 缺席但存储与返回照常——todo 的权威面是会话状态，SSE 只是投影。
 */

import { Type, defineSlot } from "@axeuh/loom-core";
import type { HarnessTool, HookContext, ToolExecResult } from "@axeuh/loom-core";

/** 状态词表（任务冻结三值；opencode 的 cancelled 不在本波面内）。 */
export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

/** 优先级词表。 */
export const TODO_PRIORITIES = ["high", "medium", "low"] as const;
export type TodoPriority = (typeof TODO_PRIORITIES)[number];

/** 条目形状（帧 properties.todos 与存储的同一真源；前端 todo.js 逐键消费 content/status/priority）。 */
export interface TodoItem {
  readonly content: string;
  readonly status: TodoStatus;
  readonly priority: TodoPriority;
}

/**
 * 装配缝签名：tool-wiring 收进 options，boot 用双惰性箭头接 registry
 * （registry 构造晚于 wiring，首次调用必在装配完成后——同 W11a onToolOutput 姿势）。
 */
export type TodoUpdatedSink = (sessionID: string, todos: readonly TodoItem[]) => void;

export interface TodoWriteToolOptions {
  /** todo.updated 上抛缝；不给 = 只写存储不发事件（直调测试旧面）。 */
  readonly onUpdated?: TodoUpdatedSink;
}

/** per-session 存储 slot（HookContext.state 唯一键；owner 前缀防撞名）。 */
export const LOOM_TODO_SLOT = defineSlot<readonly TodoItem[]>("loom.todo.items", {
  owner: "todowrite",
  validate: (v): v is readonly TodoItem[] => Array.isArray(v),
});

/** 装配 todowrite 工具（纯工厂：无 I/O 副作用；publish 全走注入缝）。 */
export function createTodoWriteTool(opts: TodoWriteToolOptions = {}): HarnessTool {
  return {
    name: "todowrite",
    description:
      "Register the FULL multi-step plan for this session as a todo list (whole-table replacement: " +
      "every call uploads the complete list; to change a status, re-send the entire table). " +
      "Each item: content = one short actionable step; status = pending | in_progress | completed; " +
      "priority = high | medium | low. Keep at most one item in_progress while working. " +
      "Publishes a todo.updated event so the UI renders the current plan. Empty array clears the board.",
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          content: Type.String({ description: "One short actionable step." }),
          status: Type.Union(
            [Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")],
            { description: "pending | in_progress | completed." },
          ),
          priority: Type.Union(
            [Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")],
            { description: "high | medium | low." },
          ),
        }),
        { description: "The COMPLETE todo table (whole-table replace semantics)." },
      ),
    }),
    // 写 ctx.state 同一 key 且发射顺序有义（后表覆盖前表）——屏障型，不并行。
    isConcurrencySafe: () => false,

    async execute(args: Record<string, unknown>, ctx: HookContext, _signal: AbortSignal): Promise<ToolExecResult> {
      // 双保险（task-fetch 同口径）：schema 之外 execute 入口再自校验——直调通路不吃 schema。
      const items = parseTodos(args.todos);
      ctx.state.set(LOOM_TODO_SLOT, items);

      // 观测面上抛（fail-soft：缝炸了不翻错模型的正事，warn 留痕）。
      if (opts.onUpdated !== undefined) {
        try {
          opts.onUpdated(ctx.sessionId, items);
        } catch (err) {
          ctx.log.warn("todowrite publish sink failed", {
            sessionID: ctx.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return textOnly(confirmationText(items));
    },
  };
}

/* ───────────────────────── 参数解析（fail-loud） ───────────────────────── */

function parseTodos(raw: unknown): readonly TodoItem[] {
  if (!Array.isArray(raw)) {
    throw new Error(`todowrite: todos must be an array (got ${JSON.stringify(raw)})`);
  }
  return raw.map((entry, idx) => parseItem(entry, idx));
}

function parseItem(raw: unknown, idx: number): TodoItem {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`todowrite: todos[${idx}] must be an object {content,status,priority}`);
  }
  const rec = raw as Record<string, unknown>;
  const content = typeof rec.content === "string" ? rec.content.trim() : "";
  if (content === "") {
    throw new Error(`todowrite: todos[${idx}].content must be a non-empty string`);
  }
  const status = rec.status;
  if (typeof status !== "string" || !(TODO_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`todowrite: todos[${idx}].status must be one of ${TODO_STATUSES.join("|")} (got ${JSON.stringify(status)})`);
  }
  const priority = rec.priority;
  if (typeof priority !== "string" || !(TODO_PRIORITIES as readonly string[]).includes(priority)) {
    throw new Error(`todowrite: todos[${idx}].priority must be one of ${TODO_PRIORITIES.join("|")} (got ${JSON.stringify(priority)})`);
  }
  return { content, status: status as TodoStatus, priority: priority as TodoPriority };
}

/* ───────────────────────── 返回文本（简短确认，模型据此续跑） ───────────────────────── */

function confirmationText(items: readonly TodoItem[]): string {
  if (items.length === 0) return "todo 已清空。";
  const done = items.filter((t) => t.status === "completed").length;
  const active = items.filter((t) => t.status === "in_progress").map((t) => t.content);
  const head = `已登记 ${items.length} 项（完成 ${done} 项）`;
  return active.length > 0
    ? `${head}，当前进行中: ${active.join("、")}`
    : `${head}，无进行中项`;
}

function textOnly(text: string): ToolExecResult {
  return { content: [{ type: "text", text }] };
}
