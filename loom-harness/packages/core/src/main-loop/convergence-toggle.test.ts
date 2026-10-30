/**
 * W26 主会话收束强制开关（convergenceEnforced）—— 验收场景。
 *
 * 用户决策（2026-10-10 10:19）："主会话增加 converge 开关，可以选择关闭这个强制要求，
 * 但仅限主会话"。本文件钉三件事，一条行为一个用例：
 *   (1) false：模型自然停 = 终局（result.type naturalStop / summary.reason "done"），
 *       零催办（账本空、事件无 outcome、转录无催办行）、零续跑（LLM call 恰 1 次）、
 *       落盘 terminal 不经 W16-F3 终审改标（reason 保持内核自然值）。
 *   (2) false + 自愿 converge（W47 语义修正）：受理即终结本轮（终审子集盖棺），
 *       终局归类 converged；催办/分级强制/续跑链依旧整体缺席（不越 W26 的界）。
 *   (3) 显式 true ≡ 缺省：纯文本空转照旧进催办链到 forceEnded（与 main-session.test.ts
 *       (4) 同判据）；converge 收束照旧 converged + 落盘改标 "done"（W16-F3 逐字节现状）。
 *
 * TDD 锚：main-session.test.ts 的 createFakeModel 脚本面（textTurn/convergeTurn/echoTurn）。
 * 侧/子会话不经本选项（各自端口自建 gate），本文件不涉及、也证明不了它们——纪律由
 * 既有 side/kernel 测试继续全绿守护。
 */

import { describe, expect, it } from "vitest";
import {
  MemorySessionStore,
  FORCE_MARK,
  type Message,
  type StoredEntry,
} from "../index.js";
import { createFakeModel, type FakeAssistantResponse } from "../testing.js";
import { MainSessionLoop } from "./loop.js";
import type { MainSessionLoopOptions } from "./types.js";

function quietSink(): void {
  /* 吞掉默认 console 输出，保持测试输出干净 */
}

function textOf(m: { content: unknown }): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((b) =>
        typeof b === "object" && b !== null && "text" in b
          ? String((b as { text: unknown }).text)
          : "",
      )
      .join("");
  }
  return "";
}

function allText(messages: ReadonlyArray<Message>): string {
  return messages.map((m) => textOf(m)).join("\n");
}

function storeMessages(entries: ReadonlyArray<StoredEntry>): Message[] {
  const out: Message[] = [];
  for (const node of entries) {
    if (node.entry.kind === "message") out.push(node.entry.message);
  }
  return out;
}

const MAIN_OK = {
  status: "已完成" as const,
  digest: "已完成：W26 自愿收束",
  body: "本轮结论：收束工具自愿调用。",
};

const convergeTurn = (): FakeAssistantResponse => ({
  content: [
    { type: "text", text: "正文收束" },
    { type: "toolCall", name: "converge", arguments: { ...MAIN_OK } },
  ],
});

const textTurn = (t: string): FakeAssistantResponse => ({
  content: [{ type: "text", text: t }],
});

function makeLoop(
  model: ReturnType<typeof createFakeModel>,
  opts: Partial<Omit<MainSessionLoopOptions, "model">> = {},
): MainSessionLoop {
  return MainSessionLoop.create({
    model,
    logSink: quietSink,
    consoleSink: quietSink,
    ...opts,
  });
}

function terminalEntriesOf(entries: ReadonlyArray<StoredEntry>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const node of entries) {
    if (node.entry.kind === "terminal") {
      out.push(node.entry.result as unknown as Record<string, unknown>);
    }
  }
  return out;
}

describe("W26 主会话免强制开关（convergenceEnforced:false）", () => {
  it("(1) 自然停 = 终局：naturalStop + reason done，零催办、零续跑、落盘不改标", async () => {
    const store = new MemorySessionStore();
    const sessionId = "w26-natural-stop";
    const model = createFakeModel([textTurn("W26 闲聊答复，不收束。")]);
    const loop = makeLoop(model, { store, sessionId, convergenceEnforced: false });

    const result = await loop.start("随便聊聊");

    // 终局形态：naturalStop（无回执可报，绝不并入 converged/forceEnded）。
    expect(result.type).toBe("naturalStop");
    if (result.type !== "naturalStop") throw new Error("unreachable");
    expect(result.summary.reason).toBe("done");
    expect(result.runs).toBe(1);
    expect(result.autoContinuationsUsed).toBe(0);
    // 零续跑 = 恰好一次 LLM call（催办链与跨请求自动续跑都会制造第二次 call）。
    expect(model.getCalls()).toHaveLength(1);
    // 零催办：gate 账本空（hooks 未挂 ⇒ reducer 无事件入口）、事件流无 outcome 记账、
    // 无 loop-forced。
    expect(loop.outcomes()).toEqual([]);
    expect(loop.events().filter((e) => e.type === "outcome")).toEqual([]);
    expect(loop.events().filter((e) => e.type === "loop-forced")).toEqual([]);
    // 转录纯净：无【收束催办】持久注入行、无强制收束 marker。
    const persisted = storeMessages(await store.getPathToLeaf(sessionId));
    const persistedText = allText(persisted);
    expect(persistedText).toContain("W26 闲聊答复");
    expect(persistedText).not.toContain("收束催办");
    expect(persistedText).not.toContain(FORCE_MARK);
    // 落盘 terminal：reason 逐字段自然值 "done"（W16-F3 改标门面未包，无 convergence abort）。
    const terminals = terminalEntriesOf(await store.getPathToLeaf(sessionId));
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.["reason"]).toBe("done");
    expect(String(terminals[0]?.["abortReason"] ?? "")).not.toContain("convergence");
    model.teardown();
  });

  it("(1b) 自愿 converge 受理即终结（W47 语义修正）：converged 终态，无需再等无工具轮", async () => {
    // 旧钉隐含假设"模型收束后总会再出一轮无工具文本"——生产不成立即死锁
    // （hm/ai 事故：25 轮全 toolUse、受理无人终审）。W47 起终审子集在自然停挂载：
    // accepted.turnIdx===本 turn → 盖棺。脚本第二条目必须**零消费**。
    const model = createFakeModel([convergeTurn(), textTurn("不该被消费的续轮")]);
    const loop = makeLoop(model, { convergenceEnforced: false });

    const result = await loop.start("自愿收束即刻终结");

    expect(result.type).toBe("converged");
    if (result.type !== "converged") throw new Error("unreachable");
    expect(result.summary.reason).toBe("aborted");
    expect(String(result.summary.abortReason)).toContain("convergence:converged");
    expect(model.getCalls(), "受理轮终结，第二 turn 零调用").toHaveLength(1);
    // 工具 execute 照常受理：回执落 toolResult details.__convergence。
    const toolResult = loop.messages.find((m) => m.role === "toolResult");
    expect(toolResult, "converge 回执通道仍在面（自愿调用照常执行）").toBeDefined();
    expect(allText(loop.messages)).toContain("收束已受理");
    expect(String(JSON.stringify(toolResult))).toContain("W26 自愿收束");
    // 账本只记受理终态这一条；催办/强制依旧零发（终审子集不含强制链）。
    const outcomes = loop.outcomes();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.type).toBe("converged");
    model.teardown();
  });

  it("(1c) abort/error 通道语义不随免强制漂移：外部 abort 仍报 aborted", async () => {
    const model = createFakeModel([textTurn("不该被消费的答复")]);
    const loop = makeLoop(model, { convergenceEnforced: false });
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await loop.start("已 abort 的请求", { signal: ctrl.signal });
    expect(result.type).toBe("aborted");
    model.teardown();
  });

  it("(2) 显式 true ≡ 缺省：纯文本空转照旧催办到 forceEnded(nudge-limit)", async () => {
    // main-session.test.ts (4) 的同判据，只是把开关显式点亮为 true——
    // 证明 "unset/true ⇒ 现状逐字节" 不只是缺省路径。
    const model = createFakeModel(
      Array.from({ length: 8 }, (_, i) => textTurn(`空转文本 ${String(i)}`)),
    );
    const loop = makeLoop(model, { convergenceEnforced: true, tools: [] });

    const result = await loop.start("只说文本永不收束");
    expect(result.type).toBe("forceEnded");
    if (result.type !== "forceEnded") throw new Error("unreachable");
    expect(result.cause).toBe("nudge-limit");
    expect(allText(loop.messages)).toContain("收束催办");
    model.teardown();
  });

  it("(2b) 显式 true ≡ 缺省：converge 收束照旧 converged + 落盘终审改标 done", async () => {
    const store = new MemorySessionStore();
    const sessionId = "w26-explicit-true-converge";
    const model = createFakeModel([convergeTurn()]);
    const loop = makeLoop(model, { store, sessionId, convergenceEnforced: true });

    const result = await loop.start("汇报并收束");
    expect(result.type).toBe("converged");
    // W16-F3 现状：内核内存契约不动（aborted + convergence 前缀），落盘持久副本改标 done。
    expect(result.summary.reason).toBe("aborted");
    expect(result.summary.abortReason).toContain("convergence:converged");
    const terminals = terminalEntriesOf(await store.getPathToLeaf(sessionId));
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.["reason"]).toBe("done");
    expect(String(terminals[0]?.["abortReason"])).toContain("convergence:converged");
    model.teardown();
  });

  it("(2c) resume 路同口径：免强制的续跑 loop 自然停同样 naturalStop、不改标", async () => {
    const store = new MemorySessionStore();
    const sessionId = "w26-resume-natural";
    const model = createFakeModel([textTurn("第一轮自然停。")]);
    const loop = makeLoop(model, { store, sessionId, convergenceEnforced: false });
    const first = await loop.start("第一问");
    expect(first.type).toBe("naturalStop");

    const model2 = createFakeModel([textTurn("续跑轮也自然停。")]);
    const resumed = await MainSessionLoop.resume({
      model: model2,
      store,
      sessionId,
      convergenceEnforced: false,
      logSink: quietSink,
      consoleSink: quietSink,
    });
    const second = await resumed.start("第二问");
    expect(second.type).toBe("naturalStop");
    expect(second.summary.reason).toBe("done");
    const terminals = terminalEntriesOf(await store.getPathToLeaf(sessionId));
    expect(terminals.map((t) => t["reason"])).toEqual(["done", "done"]);
    model.teardown();
    model2.teardown();
  });
});
