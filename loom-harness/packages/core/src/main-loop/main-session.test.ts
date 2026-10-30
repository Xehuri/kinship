/**
 * T10 主会话长循环 —— 验收场景（docs/02 §T10 三条硬判据 + D23/D26 消费契约）。
 *
 *   (1) abort（含外部 signal / 回合内 ctx.abort）后 store 已按 HWM 落盘，可 resume 续跑到收束。
 *   (2) resume 修复孤儿 toolCall 尾巴（复用 vendor `AgentSession.resume` 的合成 isError
 *       toolResult 能力；快照侧剔除用 vendor `filterIncompleteToolCalls`——本文件验证 loop 层接线）。
 *   (3) deliver 收件箱**只在 turn 边界消费**，绝不打断进行中的用户回合（D23）。
 *   (4) Outcome 消费：continued→续 / nudged→催办持久注入 / escalated→升级 / converged→终态；
 *       gate 强制与主循环预算强制均落到"需用户确认"，绝不静默假完成（D25/D26/D30）。
 *   (5) 内核 maxContinuations 接 Limits（>= gate.minKernelBudget，T09 冻结接线契约）。
 *   (6) T18 装配器在 turn 边界重装配：稳定前缀 hash 恒定 + 增量游标 O(increment) 推进。
 *
 * TDD：本文件先于实现存在时为红。全部用 createFakeModel 驱动真实 AgentSession。
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  AgentSession,
  DEFAULT_LIMITS,
  MemorySessionStore,
  Type,
  createUserMessage,
  FORCE_MARK,
  type ConvergenceOutcome,
  type HarnessTool,
  type MainReceipt,
  type Message,
  type StoredEntry,
} from "../index.js";
import {
  resolveMemorySources,
  type AssemblyPlan,
  type AssemblyReader,
  type HistoryIncrement,
} from "../assembly/index.js";
import { createFakeModel, type FakeAssistantResponse } from "../testing.js";
import { MainSessionLoop } from "./loop.js";
import type { LoopEvent, MainSessionLoopOptions } from "./types.js";

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

function countMarks(text: string, mark: string): number {
  return text.split(mark).length - 1;
}

function nth<T>(items: ReadonlyArray<T>, i: number): T {
  const v = items[i];
  if (v === undefined) throw new Error(`no element at index ${i}`);
  return v;
}

function outcomeTypesOf(e: LoopEvent): ConvergenceOutcome["type"] | null {
  return e.type === "outcome" ? e.outcome.type : null;
}

/* ────────────── 测试脚本片段 ────────────── */

const MAIN_OK = {
  status: "已完成" as const,
  digest: "已完成：巡检全部通过",
  body: "本轮结论：系统健康。",
};

const convergeTurn = (): FakeAssistantResponse => ({
  content: [
    { type: "text", text: "正文收束" },
    { type: "toolCall", name: "converge", arguments: { ...MAIN_OK } },
  ],
});

const echoTurn = (msg: string): FakeAssistantResponse => ({
  content: [{ type: "toolCall", name: "echo", arguments: { msg } }],
});

const textTurn = (t: string): FakeAssistantResponse => ({
  content: [{ type: "text", text: t }],
});

const echoTool: HarnessTool = {
  name: "echo",
  description: "干活工具（测试用），总是成功",
  parameters: Type.Object({ msg: Type.String() }),
  async execute(args) {
    return { content: [{ type: "text", text: `echo:${String(args["msg"] ?? "")}` }] };
  },
};

/** 同批 unsafe 工具：执行时 abort 会话，让后面的 safe 调用被跳过 → store 留悬挂 toolCall。 */
const aborterTool: HarnessTool = {
  name: "aborter",
  description: "干活工具（测试用），执行时中止会话",
  parameters: Type.Object({}),
  isConcurrencySafe: () => false,
  async execute(_args, ctx) {
    ctx.abort("用户中断回合");
    return { content: [{ type: "text", text: "aborted" }], isError: true };
  },
};

const skippedTool: HarnessTool = {
  name: "skipped",
  description: "干活工具（测试用），abort 后不应执行",
  parameters: Type.Object({}),
  isConcurrencySafe: () => true,
  async execute() {
    return { content: [{ type: "text", text: "should not run" }] };
  },
};

/* ────────────── store / 配对 helpers ────────────── */

function storeMessages(entries: ReadonlyArray<StoredEntry>): Message[] {
  const out: Message[] = [];
  for (const node of entries) {
    if (node.entry.kind === "message") out.push(node.entry.message);
  }
  return out;
}

function unpairedToolCallIds(messages: ReadonlyArray<Message>): string[] {
  const resultIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "toolResult") resultIds.add(m.toolCallId);
  }
  const unpaired: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const block of m.content) {
      if (block.type === "toolCall" && !resultIds.has(block.id)) unpaired.push(block.id);
    }
  }
  return unpaired;
}

function synthesizedResult(
  messages: ReadonlyArray<Message>,
  toolCallId: string,
): Message & { role: "toolResult"; isError: boolean; content: unknown } {
  const found = messages.find(
    (m) => m.role === "toolResult" && m.toolCallId === toolCallId,
  ) as (Message & { role: "toolResult"; isError: boolean; content: unknown }) | undefined;
  if (found === undefined) throw new Error(`no toolResult for ${toolCallId}`);
  return found;
}

/* ────────────── fixtures ────────────── */

function makeLoop(
  model: ReturnType<typeof createFakeModel>,
  opts: Partial<Omit<MainSessionLoopOptions, "model">> = {},
): MainSessionLoop {
  return MainSessionLoop.create({
    model,
    tools: [echoTool],
    logSink: quietSink,
    consoleSink: quietSink,
    ...opts,
  });
}

function makeResumeLoop(
  model: ReturnType<typeof createFakeModel>,
  store: MemorySessionStore,
  sessionId: string,
  tools: HarnessTool[],
): Promise<MainSessionLoop> {
  return MainSessionLoop.resume({
    model,
    tools,
    store,
    sessionId,
    logSink: quietSink,
    consoleSink: quietSink,
  });
}

function eventsOfType<K extends LoopEvent["type"]>(
  events: ReadonlyArray<LoopEvent>,
  type: K,
): Array<Extract<LoopEvent, { type: K }>> {
  return events.filter((e): e is Extract<LoopEvent, { type: K }> => e.type === type);
}

function outcomeDispositions(
  loop: MainSessionLoop,
): Array<Extract<LoopEvent, { type: "outcome" }>["disposition"]> {
  return eventsOfType(loop.events(), "outcome").map((e) => e.disposition);
}

/* ────────────── Tests ────────────── */

describe("主会话长循环（T10）", () => {
  it("(0) converge 成功收束：converged 终态带回执，记账 terminal-converged", async () => {
    const model = createFakeModel([convergeTurn()]);
    const loop = makeLoop(model);
    const result = await loop.start("汇报健康状态");

    expect(result.type).toBe("converged");
    if (result.type !== "converged") throw new Error("unreachable");
    expect((result.receipt as MainReceipt).status).toBe("已完成");
    expect(result.runs).toBe(1);
    expect(result.autoContinuationsUsed).toBe(0);
    expect(result.summary.abortReason).toContain("convergence:converged");
    // Outcome 消费终态记录：账本最后一条 = converged，处置 = terminal-converged。
    expect(outcomeTypesOf(nth(loop.events(), loop.events().length - 1))).toBe("converged");
    expect(outcomeDispositions(loop).at(-1)).toBe("terminal-converged");
    model.teardown();
  });

  it("(1) 回合进行中 abort：store 已落盘（HWM），终态 aborted 且可 resume 续跑到收束", async () => {
    const store = new MemorySessionStore();
    const sessionId = "main-lineage-abort";
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", id: "tc-abort", name: "aborter", arguments: {} },
          { type: "toolCall", id: "tc-skipped", name: "skipped", arguments: {} },
        ],
      },
    ]);
    const tools = [aborterTool, skippedTool];
    const loop = makeLoop(model, { store, sessionId, tools });
    const result = await loop.start("干活到一半被打断");

    expect(result.type).toBe("aborted");
    if (result.type !== "aborted") throw new Error("unreachable");
    expect(result.summary.abortReason).toContain("用户中断回合");

    // HWM 落盘事实：abort 前完成的 turn（user prompt + assistant + 已执行的 toolResult）已在 store。
    const persisted = storeMessages(await store.getPathToLeaf(sessionId));
    expect(persisted.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);

    // 续跑路径：resume 回同一 lineage，下一条指令收束成功。
    const model2 = createFakeModel([convergeTurn()]);
    const resumed = await makeResumeLoop(model2, store, sessionId, tools);
    expect(resumed.id).toBe(sessionId);
    const done = await resumed.start("继续，然后收束");
    expect(done.type).toBe("converged");
    model.teardown();
    model2.teardown();
  });

  it("(2) resume 修复孤儿 toolCall 尾巴：合成 isError toolResult 落盘，续跑 context 干净", async () => {
    const store = new MemorySessionStore();
    const sessionId = "main-lineage-tail";
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", id: "tc-abort", name: "aborter", arguments: {} },
          { type: "toolCall", id: "tc-skipped", name: "skipped", arguments: {} },
        ],
      },
    ]);
    const tools = [aborterTool, skippedTool];
    const loop = makeLoop(model, { store, sessionId, tools });
    await loop.start("半路 abort");

    // abort 现场：tc-skipped 被跳过执行 → store 尾巴悬挂。
    const before = storeMessages(await store.getPathToLeaf(sessionId));
    expect(unpairedToolCallIds(before)).toEqual(["tc-skipped"]);

    const model2 = createFakeModel([convergeTurn()]);
    const resumed = await makeResumeLoop(model2, store, sessionId, tools);

    // 修复事实（vendor AgentSession.resume 能力）：合成 isError toolResult **即时落盘**、内存配对。
    const after = storeMessages(await store.getPathToLeaf(sessionId));
    expect(unpairedToolCallIds(after)).toEqual([]);
    const synthesized = synthesizedResult(after, "tc-skipped");
    expect(synthesized.isError).toBe(true);
    expect(unpairedToolCallIds(resumed.messages)).toEqual([]);

    // 续跑的 LLM context 里没有悬挂 toolCall（直接发 provider 不会 orphan tool_use 400）。
    const done = await resumed.start("续跑到收束");
    expect(done.type).toBe("converged");
    const sent = nth(model2.getCalls(), 0).messages;
    expect(unpairedToolCallIds(sent)).toEqual([]);
    model.teardown();
    model2.teardown();
  });

  it("(2b) 快照剔除悬挂 toolCall：loop.snapshot() 用 vendor filterIncompleteToolCalls", async () => {
    const store = new MemorySessionStore();
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", id: "tc-abort", name: "aborter", arguments: {} },
          { type: "toolCall", id: "tc-skipped", name: "skipped", arguments: {} },
        ],
      },
    ]);
    const loop = makeLoop(model, { store, tools: [aborterTool, skippedTool] });
    await loop.start("半路 abort");

    expect(unpairedToolCallIds(loop.messages)).toContain("tc-skipped");
    const snap = loop.snapshot();
    expect(unpairedToolCallIds(snap.messages)).toEqual([]);
    // snapshot 不改活体会话（纯函数剔除、返回副本）。
    expect(unpairedToolCallIds(loop.messages)).toContain("tc-skipped");
    model.teardown();
  });

  it("(3) deliver 只在 turn 边界消费：进行中的 turn 看不到，下个 turn 的 context 才注入（D23）", async () => {
    const store = new MemorySessionStore();
    let loopRef!: MainSessionLoop;
    const deliverTool: HarnessTool = {
      name: "deliverer",
      description: "干活工具（测试用），执行时投递一条副会话回执",
      parameters: Type.Object({ msg: Type.String() }),
      isConcurrencySafe: () => true,
      async execute(args) {
        loopRef.deliver(`【副会话回执】${String(args["msg"] ?? "")}`);
        return { content: [{ type: "text", text: "delivered-to-inbox" }] };
      },
    };
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "deliverer", arguments: { msg: "run-7 done" } }] },
      convergeTurn(),
    ]);
    loopRef = makeLoop(model, { store, tools: [deliverTool] });

    const result = await loopRef.start("调度巡检");
    expect(result.type).toBe("converged");

    const calls = model.getCalls();
    // turn0 的 LLM context 建于 deliver 之前：投递消息不在其中（未打断进行中回合）。
    expect(allText(nth(calls, 0).messages)).not.toContain("run-7 done");
    // turn1 边界（onTurnStart，LLM call 组 messages 之前）drain 注入。
    expect(allText(nth(calls, 1).messages)).toContain("【副会话回执】run-7 done");
    // 消息以持久 user 形态进对话并随 HWM 落盘（不是 transient attachment）。
    const persisted = storeMessages(await store.getPathToLeaf(loopRef.id));
    expect(persisted.some((m) => m.role === "user" && textOf(m).includes("run-7 done"))).toBe(true);
    // 边界事件记账：turnIdx=1 消费 1 条；队列排空。
    const drained = eventsOfType(loopRef.events(), "delivery-drained");
    expect(drained).toHaveLength(1);
    expect(nth(drained, 0).turnIdx).toBe(1);
    expect(nth(drained, 0).count).toBe(1);
    expect(loopRef.pendingDeliveries()).toBe(0);
    model.teardown();
  });

  it("(3b) idle 时 deliver 入队不生效：下个请求的首个 turn 边界才消费", async () => {
    const model = createFakeModel([convergeTurn()]);
    const loop = makeLoop(model);
    loop.deliver(createUserMessage("【死信】run-9 failed：超时"));
    expect(loop.pendingDeliveries()).toBe(1);

    const result = await loop.start("新指令");
    expect(result.type).toBe("converged");
    expect(allText(nth(model.getCalls(), 0).messages)).toContain("【死信】run-9 failed");
    expect(loop.pendingDeliveries()).toBe(0);
    const drained = eventsOfType(loop.events(), "delivery-drained");
    expect(drained).toHaveLength(1);
    expect(nth(drained, 0).turnIdx).toBe(0);
    model.teardown();
  });

  it("(3c) deliver 拒收非 user role（对话不变量，fail-loud）", () => {
    const model = createFakeModel([]);
    const loop = makeLoop(model);
    const fakeAssistant = { role: "assistant", content: "x", timestamp: 0 } as unknown as Message;
    expect(() => loop.deliver(fakeAssistant)).toThrow(/user-role/);
    expect(loop.pendingDeliveries()).toBe(0);
    model.teardown();
  });

  /* ────────────── W12 提醒通道（transient，绝不进转录） ────────────── */

  const REMINDER_A = '[run-reminder] run=run_aaaa workflow=w-a status=done side_session=ses_aaaa；副会话已终态，取件用 task_fetch(session_id="ses_aaaa") 或 GET /runs/run_aaaa。';
  const REMINDER_B = '[run-reminder] run=run_bbbb workflow=w-b status=partial side_session=ses_bbbb；副会话已终态，取件用 task_fetch(session_id="ses_bbbb") 或 GET /runs/run_bbbb。';

  it("(3d) W12 remind：idle 滞留 → 下轮 transient 注入——模型收得到、session.messages/store 全不含（'不在历史中'）", async () => {
    const store = new MemorySessionStore();
    const sessionId = "w12-remind-lineage";
    const drained: Array<{ turnIdx: number; texts: readonly string[] }> = [];
    const model = createFakeModel([convergeTurn()]);
    const loop = makeLoop(model, { store, sessionId, onRemindersDrained: (turnIdx, texts) => drained.push({ turnIdx, texts }) });

    expect(() => loop.remind("   ")).toThrow(/non-blank/);
    loop.remind(REMINDER_A);
    expect(loop.pendingReminders()).toBe(1); // 滞留可见性 = 边界内存队列

    const result = await loop.start("第二问");
    expect(result.type).toBe("converged");

    // a) 模型收到的 prompt 含提醒行（attachment 拼进 messages view 尾部）。
    const sent = nth(model.getCalls(), 0).messages;
    expect(allText(sent)).toContain(REMINDER_A);
    // b) 提醒绝不进对话内存/转录：session.messages、loop.messages、store 落盘行——三处全不含。
    expect(allText(loop.messages)).not.toContain(REMINDER_A);
    const persisted = storeMessages(await store.getPathToLeaf(sessionId));
    expect(persisted.map((m) => textOf(m)).join("\n")).not.toContain(REMINDER_A);
    // c) 边界消费记账 + 队列清空 + 回调回报注入文本（server 侧据此发 delivery.notify）。
    expect(loop.pendingReminders()).toBe(0);
    const events = eventsOfType(loop.events(), "reminder-drained");
    expect(events).toHaveLength(1);
    expect(nth(events, 0).turnIdx).toBe(0);
    expect(nth(events, 0).count).toBe(1);
    expect(drained).toHaveLength(1);
    expect(nth(drained, 0).texts).toEqual([REMINDER_A]);
    model.teardown();
  });

  it("(3e) W12 remind 只在 turn 边界消费：进行中的 turn 看不到，下个 turn 的 context 才注入", async () => {
    let loopRef!: MainSessionLoop;
    const reminterTool: HarnessTool = {
      name: "reminter",
      description: "干活工具（测试用），执行时入队一条终态提醒",
      parameters: Type.Object({ line: Type.String() }),
      isConcurrencySafe: () => true,
      async execute(args) {
        loopRef.remind(String(args["line"] ?? ""));
        return { content: [{ type: "text", text: "reminded" }] };
      },
    };
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "reminter", arguments: { line: REMINDER_A } }] },
      convergeTurn(),
    ]);
    loopRef = makeLoop(model, { tools: [reminterTool] });

    const result = await loopRef.start("开火");
    expect(result.type).toBe("converged");
    // turn0 context 建于 remind 之前（不打断进行中回合）；turn1 边界注入。
    expect(allText(nth(model.getCalls(), 0).messages)).not.toContain(REMINDER_A);
    expect(allText(nth(model.getCalls(), 1).messages)).toContain(REMINDER_A);
    expect(loopRef.pendingReminders()).toBe(0);
    model.teardown();
  });

  it("(3f) W12 多条提醒按序全注入并清空；只进装配段3，稳定前缀字节不动", async () => {
    class FakeReader implements AssemblyReader {
      readText(_path: string): string | null {
        return "# 稳定记忆\n核心规则。";
      }
      readHistoryIncrement(): HistoryIncrement {
        return { lines: [], openedShards: 0 };
      }
      historyLength(): number {
        return 0;
      }
    }
    const { sources } = resolveMemorySources(new FakeReader(), ["AGENTS.md"]);
    const plan: AssemblyPlan = { systemPrompt: "你是 loom 主会话。", memorySources: sources, workflows: [] };

    const model = createFakeModel([convergeTurn()]);
    const loop = makeLoop(model, { assembly: { plan, reader: new FakeReader() } });
    loop.remind(REMINDER_A);
    loop.remind(REMINDER_B);

    const result = await loop.start("收口问");
    expect(result.type).toBe("converged");

    // a) 单条 attachment、两行按入队序全量注入。
    const sent = allText(nth(model.getCalls(), 0).messages);
    expect(sent).toContain(REMINDER_A);
    expect(sent.indexOf(REMINDER_A)).toBeLessThan(sent.indexOf(REMINDER_B));
    // b) 装配增量段呈现 reminder 行（一次消费），且前缀 hash 与后续边界恒等（段3 易变纪律）。
    const assemblies = loop.assemblies();
    expect(assemblies).toHaveLength(1); // converge 单 turn 收束，边界只过一次
    const inc = assemblies[0]!.segments.find((s) => s.name === "increment");
    if (inc === undefined) throw new Error("no increment segment");
    const incText = new TextDecoder().decode(inc.bytes);
    expect(incText).toContain(`reminder: ${REMINDER_A}`);
    expect(incText).toContain(`reminder: ${REMINDER_B}`);
    expect(incText.indexOf(`reminder: ${REMINDER_A}`)).toBeLessThan(incText.indexOf(`reminder: ${REMINDER_B}`));
    // c) 消费后清空：再开一问，旧提醒不重现（transient 一次性）。
    const model2 = createFakeModel([convergeTurn()]);
    const loop2 = makeLoop(model2, { assembly: { plan, reader: new FakeReader() } });
    await loop2.start("第二问");
    expect(allText(nth(model2.getCalls(), 0).messages)).not.toContain(REMINDER_A);
    // 前缀稳定纪律硬证：提醒进段3 的两个 loop 与无提醒 loop，前缀 hash 逐字节恒等。
    expect(assemblies[0]!.prefixHash).toBe(nth(loop2.assemblies(), 0).prefixHash);
    expect(assemblies[0]!.fullHash).not.toBe(nth(loop2.assemblies(), 0).fullHash);
    const events = eventsOfType(loop.events(), "reminder-drained");
    expect(events).toHaveLength(1);
    expect(nth(events, 0).count).toBe(2);
    model.teardown();
    model2.teardown();
  });

  it("(4) 纯文本空转：催办 5 次持久注入 → gate 强制收束，终态 forceEnded(需用户确认) 绝不假完成", async () => {
    const model = createFakeModel(
      Array.from({ length: 8 }, (_, i) => textTurn(`空转文本 ${String(i)}`)),
    );
    const loop = makeLoop(model, { tools: [] });
    const result = await loop.start("只说文本永不收束");

    expect(result.type).toBe("forceEnded");
    if (result.type !== "forceEnded") throw new Error("unreachable");
    expect(result.cause).toBe("nudge-limit");
    expect(result.deadLetter).toBe(false); // 主会话强制不死信，直接落终态记录
    const receipt = result.receipt as MainReceipt;
    expect(receipt.status).toBe("需用户确认");
    expect(receipt.digest).toContain("催办上限");

    // 催办 = 持久注入进对话（模型看得见），并全部如实记账 nudge-injected。
    expect(countMarks(allText(loop.messages), "【收束催办】")).toBe(5);
    const dispositions = outcomeDispositions(loop);
    expect(dispositions.filter((d) => d === "nudge-injected")).toHaveLength(5);
    expect(dispositions.at(-1)).toBe("terminal-forced");
    model.teardown();
  });

  it("(5) 同工具同错×3 → escalated 如实记账，会话继续直到真实收束", async () => {
    const flaky: HarnessTool = {
      name: "flaky",
      description: "干活工具（测试用），总是抛错",
      parameters: Type.Object({ msg: Type.String() }),
      async execute(args) {
        throw new Error(`flaky-fail:${String(args["msg"] ?? "")}`);
      },
    };
    const turn = (msg: string): FakeAssistantResponse => ({
      content: [{ type: "toolCall", name: "flaky", arguments: { msg } }],
    });
    const model = createFakeModel([turn("a"), turn("a"), turn("a"), convergeTurn()]);
    const loop = makeLoop(model, { tools: [flaky] });
    const result = await loop.start("反复踩同一个坑");

    expect(result.type).toBe("converged");
    const dispositions = outcomeDispositions(loop);
    expect(dispositions.filter((d) => d === "escalation-recorded")).toHaveLength(1);
    expect(outcomeTypesOf(nth(loop.events(), loop.events().length - 1))).toBe("converged");
    expect(allText(loop.messages)).toContain("【收束升级】");
    model.teardown();
  });

  it("(6) 跨请求自动续跑：每请求自然截停 → continue 接续到收束（runs 记账）", async () => {
    // maxTurns=1：turn 以 toolUse 结束被内核 max_turns 截停（非收束终态）→
    // loop 用 session.continue() 跨请求接续，直至模型收束。
    const model = createFakeModel([echoTurn("w1"), echoTurn("w2"), convergeTurn()]);
    const loop = makeLoop(model, {
      maxTurns: 1,
      limits: { ...DEFAULT_LIMITS, nudgeLimit: 50, turnHardCap: 50 },
    });
    const result = await loop.start("干两活再收束");

    expect(result.type).toBe("converged");
    if (result.type !== "converged") throw new Error("unreachable");
    expect(result.runs).toBe(3);
    expect(result.autoContinuationsUsed).toBe(2);
    expect(model.getCalls()).toHaveLength(3);
    model.teardown();
  });

  it("(6b) 自动续跑预算用尽（默认2）：自动收束\"需用户确认\" + marker 注入下个 turn 边界，绝不静默假完成", async () => {
    // 脚本恰好 3 条干活轮：1 请求 + 2 自动续跑（Limits.autoContinuations 冻结默认）后预算用尽。
    const model = createFakeModel([echoTurn("w0"), echoTurn("w1"), echoTurn("w2")]);
    const loop = makeLoop(model, {
      maxTurns: 1,
      limits: { ...DEFAULT_LIMITS, nudgeLimit: 100, turnHardCap: 100 },
    });
    const result = await loop.start("永远干活永不收束");

    expect(result.type).toBe("forceEnded");
    if (result.type !== "forceEnded") throw new Error("unreachable");
    expect(result.cause).toBe("auto-continuations-exhausted");
    expect(result.runs).toBe(3); // 1 请求 + 2 自动续跑（Limits.autoContinuations 冻结默认）
    expect(result.autoContinuationsUsed).toBe(2);
    const receipt = result.receipt as MainReceipt;
    expect(receipt.status).toBe("需用户确认");
    expect(receipt.blockers).toEqual(["自动续跑上限"]);
    expect(eventsOfType(loop.events(), "loop-forced")).toHaveLength(1);

    // marker 是持久注入：下个用户请求的首个 turn 边界进对话，模型与落盘都看得到。
    model.push(convergeTurn());
    const next = await loop.start("用户处置后继续");
    expect(next.type).toBe("converged");
    expect(allText(loop.messages)).toContain(FORCE_MARK);
    expect(allText(loop.messages)).toContain("自动续跑上限");
    model.teardown();
  });

  it("(7) 内核 maxContinuations 接 Limits：= max(nudgeLimit, 5)（gate.minKernelBudget 接线契约）", () => {
    const m = createFakeModel([]);
    const loop1 = makeLoop(m, { limits: { ...DEFAULT_LIMITS, nudgeLimit: 8 } });
    expect(loop1.session.maxContinuations).toBe(8);
    const loop2 = makeLoop(m, { limits: { ...DEFAULT_LIMITS, nudgeLimit: 2 } });
    expect(loop2.session.maxContinuations).toBe(5); // 下限 = AgentSession 默认 5
    m.teardown();
  });

  it("(8) T18 装配在 turn 边界重装配：前缀 hash 恒定、增量游标 O(increment) 推进", async () => {
    class FakeReader implements AssemblyReader {
      readonly rows: string[] = ["row-1", "row-2"];
      readText(_path: string): string | null {
        return "# 稳定记忆\n核心规则。";
      }
      readHistoryIncrement(from: number): HistoryIncrement {
        const lines = this.rows.slice(from);
        return { lines, openedShards: lines.length > 0 ? 1 : 0 };
      }
      historyLength(): number {
        return this.rows.length;
      }
    }
    const reader = new FakeReader();
    const { sources } = resolveMemorySources(reader, ["AGENTS.md"]);
    const plan: AssemblyPlan = {
      systemPrompt: "你是 loom 主会话。",
      memorySources: sources,
      workflows: [],
    };

    const model = createFakeModel([echoTurn("干活"), convergeTurn()]);
    const loop = makeLoop(model, { assembly: { plan, reader }, maxTurns: 4 });
    const result = await loop.start("开工");
    expect(result.type).toBe("converged");

    const assemblies = loop.assemblies();
    expect(assemblies).toHaveLength(2); // turn0 / turn1 边界各一次
    const a0 = nth(assemblies, 0);
    const a1 = nth(assemblies, 1);
    expect(a0.prefixHash).toBe(a1.prefixHash); // 稳定前缀字节恒定（cache 命中结构）
    expect(a0.fullHash).not.toBe(a1.fullHash);
    expect(a0.incrementRows).toBe(2); // 首边界：全量历史行入增量段
    expect(a1.incrementRows).toBe(0); // 游标推进到 historyLength → 只读增量（O(increment)）
    const incText = (i: number): string => {
      const seg = nth(assemblies, i).segments.find((s) => s.name === "increment");
      if (seg === undefined) throw new Error("no increment segment");
      return new TextDecoder().decode(seg.bytes);
    };
    expect(incText(0)).toContain("user: 开工"); // 本轮 prompt 进增量尾
    expect(incText(1)).not.toContain("user: 开工"); // 只在首个边界消费一次
    expect(eventsOfType(loop.events(), "assembly").map((e) => e.turnIdx)).toEqual([0, 1]);
    model.teardown();
  });

  it("(9) 并发 start 拒绝；外部已 abort 的 signal 直接 aborted；loop.abort 幂等", async () => {
    const model = createFakeModel([echoTurn("w"), convergeTurn()]);
    const loop = makeLoop(model);
    const running = loop.start("请求A");
    // 同步重入被拒（_active 守卫，不等 await 竞争）。
    await expect(loop.start("请求B")).rejects.toThrow(/already in progress/);
    const first = await running;
    expect(first.type).toBe("converged");
    loop.abort();
    loop.abort(); // 幂等：不抛

    const ctrl = new AbortController();
    ctrl.abort();
    const model2 = createFakeModel([convergeTurn()]);
    const loop2 = makeLoop(model2);
    const aborted = await loop2.start("请求C", { signal: ctrl.signal });
    expect(aborted.type).toBe("aborted");
    expect(model2.getCalls()).toHaveLength(0); // 外部 signal 在建 run 时即转发
    model.teardown();
    model2.teardown();
  });

  it("(10) Unit B 请求面：装配接线时逐轮 LLM 请求 systemPrompt = plan 前缀字节、跨轮恒定", async () => {
    // 请求面（非簿记面）硬断言：assemble() 产物此前只进 events/trace，模型从未收到——
    // 本测钉死接线结局：前缀渲染字节进 Context.systemPrompt，且字节 = prefixHash 声明源。
    class FakeReader implements AssemblyReader {
      readText(_path: string): string | null {
        return "# 稳定记忆\nUNIT-B-CORE-核心规则。";
      }
      readHistoryIncrement(): HistoryIncrement {
        return { lines: [], openedShards: 0 };
      }
      historyLength(): number {
        return 0;
      }
    }
    const { sources } = resolveMemorySources(new FakeReader(), ["AGENTS.md"]);
    const plan: AssemblyPlan = { systemPrompt: "你是 loom 主会话。", memorySources: sources, workflows: [] };

    const model = createFakeModel([echoTurn("干活"), convergeTurn()]);
    const loop = makeLoop(model, { assembly: { plan, reader: new FakeReader() }, maxTurns: 4 });
    const result = await loop.start("开工问一句");
    expect(result.type).toBe("converged");

    const calls = model.getCalls();
    expect(calls).toHaveLength(2); // turn0 LLM + turn1 LLM
    const sys0 = calls[0]?.systemPrompt;
    if (sys0 === undefined) throw new Error("装配接线后每轮请求必须携带 systemPrompt");
    // a) 身份段 + memory 段字节进请求（主会话前缀的最小等价：稳定记忆正文可达；W33 后清单单件，等价面不变）。
    expect(sys0).toContain("## system");
    expect(sys0).toContain("你是 loom 主会话。");
    expect(sys0).toContain("UNIT-B-CORE-核心规则。");
    // b) 易变内容绝不进前缀：本轮 prompt 走 messages 尾，不混进 systemPrompt。
    expect(sys0).not.toContain("开工问一句");
    // c) 跨轮字节稳定（W14 前缀纪律的请求面形态）：turn1 与 turn0 的 systemPrompt 全等。
    expect(calls[1]!.systemPrompt).toBe(sys0);
    // d) 请求字节 = trace 声明的前缀：sha256(上送 systemPrompt) === 装配事件 prefixHash
    //   （前缀跨边界恒定，取任一装配事件核对即可；assemblies 非空已由 (8) 类边界断言保证）。
    const hash = `sha256:${createHash("sha256").update(Buffer.from(sys0, "utf8")).digest("hex")}`;
    expect(loop.assemblies().length).toBeGreaterThan(0);
    expect(nth(loop.assemblies(), 0).prefixHash).toBe(hash);
    model.teardown();
  });

  it("(11) W16-F3 终态纠错：converge 受理轮落盘 terminal reason=done、真 abort 留 aborted", async () => {
    const store = new MemorySessionStore();
    const sessionId = "main-lineage-label";
    const model = createFakeModel([convergeTurn()]);
    const loop = makeLoop(model, { store, sessionId, tools: [echoTool, aborterTool] });

    const result = await loop.start("汇报并盖棺");
    expect(result.type).toBe("converged");
    if (result.type !== "converged") throw new Error("unreachable");
    // 内核内存契约逐字节不动（gate.ts 冻结判据）：内存 summary 仍是 aborted + 前缀。
    expect(result.summary.reason).toBe("aborted");
    expect(result.summary.abortReason).toContain("convergence:converged");

    // 落盘 terminal：reason 已改标为内核既有词 "done"（不造第三词）；abortReason 留审计原样。
    const terminalsOf = async (): Promise<Array<{ reason: string; abortReason?: string }>> => {
      const path = await store.getPathToLeaf(sessionId);
      const out: Array<{ reason: string; abortReason?: string }> = [];
      for (const node of path) {
        if (node.entry.kind === "terminal") {
          out.push({ reason: node.entry.result.reason, ...(node.entry.result.abortReason === undefined ? {} : { abortReason: node.entry.result.abortReason }) });
        }
      }
      return out;
    };
    const t1 = await terminalsOf();
    expect(t1).toHaveLength(1);
    expect(nth(t1, 0).reason).toBe("done");
    expect(nth(t1, 0).abortReason).toContain("convergence:converged");

    // 第二轮真 abort（工具 ctx.abort "用户中断回合"）：terminal 保持 "aborted"，绝不误改标。
    model.push({
      content: [{ type: "toolCall", id: "tc-11-abort", name: "aborter", arguments: {} }],
    });
    const second = await loop.start("再干一半被打断");
    expect(second.type).toBe("aborted");
    const t2 = await terminalsOf();
    expect(t2).toHaveLength(2);
    expect(nth(t2, 1).reason).toBe("aborted");
    model.teardown();
  });
});

/* ────────────── promptTimestamp：队列 prompt 的 accept 时刻 ────────────── */

function userMessageWithContent(
  messages: ReadonlyArray<Message>,
  content: string,
): Message & { role: "user" } {
  const found = messages.find((m) => m.role === "user" && m.content === content);
  if (found === undefined || found.role !== "user") {
    throw new Error(`no user message with content: ${content}`);
  }
  return found;
}

describe("promptTimestamp：队列 prompt 保留 accept 时刻", () => {
  it("run(prompt, { promptTimestamp }) 写入 user message 原值，contextNotices 仍取 Date.now()", async () => {
    const model = createFakeModel([textTurn("收到")]);
    const session = new AgentSession({
      model,
      tools: [],
      logSink: quietSink,
      consoleSink: quietSink,
    });

    const before = Date.now();
    await session.run("queued-x", {
      promptTimestamp: 12345,
      contextNotices: ["notice-a", "notice-b"],
    });
    const after = Date.now();

    expect(userMessageWithContent(session.messages, "queued-x").timestamp).toBe(12345);
    for (const notice of ["notice-a", "notice-b"]) {
      const timestamp = userMessageWithContent(session.messages, notice).timestamp;
      expect(timestamp).not.toBe(12345);
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    }
    model.teardown();
  });

  it("省略 promptTimestamp：user message 仍按 Date.now() 取值（有限且非队列时刻）", async () => {
    const model = createFakeModel([textTurn("收到")]);
    const session = new AgentSession({
      model,
      tools: [],
      logSink: quietSink,
      consoleSink: quietSink,
    });

    const before = Date.now();
    await session.run("plain-x");
    const after = Date.now();

    const timestamp = userMessageWithContent(session.messages, "plain-x").timestamp;
    expect(Number.isFinite(timestamp)).toBe(true);
    expect(timestamp).not.toBe(12345);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
    model.teardown();
  });

  it("MainSessionLoop.start 将 promptTimestamp 透传到首个 request 的 user message", async () => {
    const model = createFakeModel([convergeTurn()]);
    const loop = makeLoop(model);

    await loop.start("queued-main", { promptTimestamp: 12345 });

    expect(userMessageWithContent(loop.messages, "queued-main").timestamp).toBe(12345);
    model.teardown();
  });
});
