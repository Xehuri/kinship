/**
 * W11b todowrite 单测 —— 整表替换/per-session 隔离/publish 形状/fail-loud/缝炸 fail-soft。
 * Given: 纯 fake HookContext（state=Map 薄壳 + log.warn 采集），fake sink 捕获上抛参数
 * When:  直调 tool.execute 正表/二表覆盖/空表/坏参数/sink 抛错
 * Then:  sink 收 (ctx.sessionId, 归一三键表)；state slot 恒为**最后一次整表**（无增量）；
 *        两会话同工具实例互不串写；properties 形状 = {content,status,priority}×N；
 *        词表外/空 content/非数组一律抛；sink 异常只 warn 不翻错正事。
 */

import { describe, expect, it } from "vitest";
import type { HookContext, ToolExecResult } from "@axeuh/loom-core";

import {
  LOOM_TODO_SLOT,
  createTodoWriteTool,
  type TodoItem,
  type TodoUpdatedSink,
} from "./todo-tool.js";

interface FakeCtx {
  readonly ctx: HookContext;
  readonly store: Map<string, unknown>;
  readonly warnings: string[];
}

function makeCtx(sessionId: string): FakeCtx {
  const store = new Map<string, unknown>();
  const warnings: string[] = [];
  const ctx = {
    sessionId,
    state: {
      get: (key: unknown) => store.get(typeof key === "string" ? key : (key as { key: string }).key),
      set: (key: unknown, value: unknown) => {
        store.set((key as { key: string }).key, value);
      },
      has: (key: unknown) => store.has((key as { key: string }).key),
      delete: (key: unknown) => store.delete((key as { key: string }).key),
    },
    log: {
      debug: () => {}, info: () => {}, error: () => {},
      warn: (msg: string) => { warnings.push(msg); },
    },
  } as unknown as HookContext;
  return { ctx, store, warnings };
}

const sig = new AbortController().signal;

function captures(): { sink: TodoUpdatedSink; got: Array<{ sid: string; todos: readonly TodoItem[] }> } {
  const got: Array<{ sid: string; todos: readonly TodoItem[] }> = [];
  return { sink: (sid, todos) => { got.push({ sid, todos }); }, got };
}

function resultText(r: ToolExecResult): string {
  const block = r.content[0];
  expect(block?.type).toBe("text");
  return block && block.type === "text" ? block.text : "";
}

const PLAN: TodoItem[] = [
  { content: "调研事件面", status: "in_progress", priority: "high" },
  { content: "写工具", status: "pending", priority: "high" },
  { content: "补测试", status: "pending", priority: "medium" },
];

describe("todowrite：登记 + publish 形状 + 返回文本", () => {
  it("三步计划首步进行中：sink 收到 (sid, 全表)，返回文本含计数与进行中项", async () => {
    const { sink, got } = captures();
    const tool = createTodoWriteTool({ onUpdated: sink });
    const { ctx, store } = makeCtx("ses_main_0001");
    const r = await tool.execute({ todos: PLAN }, ctx, sig);
    expect(got).toHaveLength(1);
    expect(got[0]!.sid).toBe("ses_main_0001");
    expect(got[0]!.todos).toEqual(PLAN);
    // 条目形状逐字三键（帧 properties.todos = 前端消费形状）
    expect(Object.keys(got[0]!.todos[0]!).sort()).toEqual(["content", "priority", "status"]);
    expect(store.get(LOOM_TODO_SLOT.key)).toEqual(PLAN);
    const text = resultText(r);
    expect(text).toContain("已登记 3 项");
    expect(text).toContain("当前进行中: 调研事件面");
  });

  it("整表替换：第二张全量表覆盖第一张，slot 与 sink 都只反映最新表", async () => {
    const { sink, got } = captures();
    const tool = createTodoWriteTool({ onUpdated: sink });
    const { ctx, store } = makeCtx("ses_main_0001");
    await tool.execute({ todos: PLAN }, ctx, sig);
    const SECOND: TodoItem[] = [
      { content: "调研事件面", status: "completed", priority: "high" },
      { content: "写工具", status: "in_progress", priority: "high" },
    ];
    const r = await tool.execute({ todos: SECOND }, ctx, sig);
    expect(got[1]!.todos).toEqual(SECOND);
    expect(store.get(LOOM_TODO_SLOT.key)).toEqual(SECOND); // 无残留增量合并
    expect(resultText(r)).toContain("完成 1 项");
  });

  it("空表 = 清空：sink 收到空数组，返回清空确认", async () => {
    const { sink, got } = captures();
    const tool = createTodoWriteTool({ onUpdated: sink });
    const { ctx, store } = makeCtx("ses_main_0001");
    await tool.execute({ todos: PLAN }, ctx, sig);
    const r = await tool.execute({ todos: [] }, ctx, sig);
    expect(got[1]!.todos).toEqual([]);
    expect(store.get(LOOM_TODO_SLOT.key)).toEqual([]);
    expect(resultText(r)).toContain("已清空");
  });

  it("per-session 隔离：同一工具实例，两会话各写各的 state，互不串写", async () => {
    const { sink, got } = captures();
    const tool = createTodoWriteTool({ onUpdated: sink });
    const a = makeCtx("ses_main_aaaa");
    const b = makeCtx("ses_child_bbbb");
    await tool.execute({ todos: PLAN }, a.ctx, sig);
    expect(b.store.has(LOOM_TODO_SLOT.key)).toBe(false); // B 未被 A 的写入污染
    const bPlan: TodoItem[] = [{ content: "子会话自己的步骤", status: "pending", priority: "low" }];
    await tool.execute({ todos: bPlan }, b.ctx, sig);
    expect(a.store.get(LOOM_TODO_SLOT.key)).toEqual(PLAN); // A 表不变
    expect(got.map((g) => g.sid)).toEqual(["ses_main_aaaa", "ses_child_bbbb"]);
  });
});

describe("todowrite：fail-loud 与缝 fail-soft", () => {
  it("坏参数全部响亮抛：非数组 todos / 词表外 status / 词表外 priority / 空 content / 非对象条目", async () => {
    const tool = createTodoWriteTool({});
    const { ctx } = makeCtx("ses_main_0001");
    await expect(tool.execute({ todos: "not-array" }, ctx, sig)).rejects.toThrow(/todos must be an array/);
    await expect(
      tool.execute({ todos: [{ content: "x", status: "doing", priority: "high" }] }, ctx, sig),
    ).rejects.toThrow(/status must be one of pending\|in_progress\|completed/);
    await expect(
      tool.execute({ todos: [{ content: "x", status: "pending", priority: "urgent" }] }, ctx, sig),
    ).rejects.toThrow(/priority must be one of high\|medium\|low/);
    await expect(
      tool.execute({ todos: [{ content: "   ", status: "pending", priority: "low" }] }, ctx, sig),
    ).rejects.toThrow(/content must be a non-empty string/);
    await expect(tool.execute({ todos: [null] }, ctx, sig)).rejects.toThrow(/must be an object/);
  });

  it("publish 缝抛错不翻错正事：返回仍 ok，warn 留痕一条", async () => {
    const tool = createTodoWriteTool({
      onUpdated: () => { throw new Error("hub down"); },
    });
    const { ctx, warnings, store } = makeCtx("ses_main_0001");
    const r = await tool.execute({ todos: PLAN }, ctx, sig);
    expect(resultText(r)).toContain("已登记 3 项");
    expect(store.get(LOOM_TODO_SLOT.key)).toEqual(PLAN); // 存储先于上抛，写入不受缝影响
    expect(warnings).toEqual(["todowrite publish sink failed"]);
  });

  it("不给缝（直调旧面）：只写存储与返回，绝不抛", async () => {
    const tool = createTodoWriteTool();
    const { ctx, store } = makeCtx("ses_main_0001");
    const r = await tool.execute({ todos: PLAN }, ctx, sig);
    expect(store.get(LOOM_TODO_SLOT.key)).toEqual(PLAN);
    expect(resultText(r)).toContain("已登记 3 项");
  });
});
