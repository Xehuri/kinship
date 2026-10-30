/**
 * T09 收束工具终止机制 —— 验收场景 (a)-(e)（docs/02 §T09，冻结语义 docs/01 D25/D26/D30/D31）。
 *
 *   (a) 纯文本结束**不**终止会话——只有收束工具成功调用且必填字段齐才停。
 *   (b) 缺字段 → 催办 nudge，最多 5 次后升级 → 强制分级收束（绝不静默假完成）。
 *   (c) 同工具同错误 ×3 → 升级提示（阈值从 Limits 实时读、热载可改）。
 *   (d) 轮数硬顶（默认 60）→ 强制分级收束（主=需用户确认；副=failed+死信）。
 *   (e) 收束可与干活工具同轮混用——同批全部执行、收束照常受理；正文+收束同轮零额外往返。
 *
 * 关键消费契约（T10/T12 必读）：成功收束的 run 在内核里必然以 reason:"aborted" 盖棺
 * （收束 turn 含 toolCall，内核无 toolCall 才自然 done；gate 只能在 loop 内 abort）。
 * 「收束终止」的判据 = abortReason 以 "convergence:" 开头 + gate.runOutcome()。
 *
 * TDD：本文件先于实现存在时为红。全部用 createFakeModel 驱动真实 AgentSession。
 */

import { describe, expect, it } from "vitest";
import {
  AgentSession,
  ConvergenceGate,
  DEFAULT_LIMITS,
  Type,
  type ConvergenceOutcome,
  type HarnessTool,
  type Hook,
  type Limits,
  type MainReceipt,
  type Message,
  type SideReceipt,
} from "../index.js";
import { createFakeModel, type FakeAssistantResponse } from "../testing.js";

/* ────────────── 消费方契约：exhaustive switch（T10/T12 就这样消费） ────────────── */

const NUDGE_MARK = "【收束催办】";
const ESCALATE_MARK = "【收束升级】";
const DEAD_LETTER_MARK = "【死信】";

interface ConvergenceReceiptResult {
  converged: boolean;
  outcome: ConvergenceOutcome;
  receipt?: MainReceipt | SideReceipt;
  deadLetter?: boolean;
}

function assertNever(v: never): never {
  throw new Error(`unhandled ConvergenceOutcome variant: ${JSON.stringify(v)}`);
}

/** 判别联合 exhaustive switch——编译期保证 T09 导出语义完整。 */
function describeOutcome(o: ConvergenceOutcome): string {
  switch (o.type) {
    case "converged":
      return `converged:${o.status}`;
    case "nudged":
      return `nudged:${o.reason}`;
    case "escalated":
      return `escalated:${o.tool}`;
    case "forceEnded":
      return `forceEnded:${o.reason}:${o.receipt.status}`;
    case "continued":
      return `continued:${o.nudgeCount}`;
    default:
      return assertNever(o);
  }
}

function requireOutcome(o: ConvergenceOutcome | null): ConvergenceOutcome {
  if (o === null) throw new Error("expected a terminal outcome, got null");
  return o;
}

function nth<T>(items: ReadonlyArray<T>, i: number): T {
  const v = items[i];
  if (v === undefined) throw new Error(`no element at index ${i}`);
  return v;
}

/* ────────────── 消息 helpers ────────────── */

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
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
  return messages
    .map((m) => textOf((m as { content?: unknown }).content))
    .join("\n");
}

function countMarks(text: string, mark: string): number {
  return text.split(mark).length - 1;
}

/**
 * 收束回执 marker 的两条落盘通道：
 *   1. 真实收束 → converge toolResult 的 details.__convergence
 *   2. 强制收束 → gate 追加的持久 user message 的 _meta.kind="convergence_receipt"
 */
function markerResults(messages: ReadonlyArray<Message>): ConvergenceReceiptResult[] {
  const out: ConvergenceReceiptResult[] = [];
  for (const m of messages) {
    if (m.role === "toolResult" && m.toolName === "converge") {
      const d = (
        m as { details?: { __convergence?: ConvergenceReceiptResult } }
      ).details;
      if (d !== undefined && d.__convergence !== undefined) out.push(d.__convergence);
    }
    if (m.role === "user") {
      const meta = (
        m as { _meta?: { kind?: string; result?: ConvergenceReceiptResult } }
      )._meta;
      if (meta !== undefined && meta.kind === "convergence_receipt" && meta.result !== undefined) {
        out.push(meta.result);
      }
    }
  }
  return out;
}

function receiptsOf(
  messages: ReadonlyArray<Message>,
): Array<MainReceipt | SideReceipt> {
  return markerResults(messages)
    .map((r) => r.receipt)
    .filter((r): r is MainReceipt | SideReceipt => r !== undefined);
}

/* ────────────── 测试 fixtures ────────────── */

function quietSink(): void {
  /* 吞掉默认 console 输出，保持测试输出干净 */
}

const echoTool: HarnessTool = {
  name: "echo",
  description: "干活工具（测试用），总是成功",
  parameters: Type.Object({ msg: Type.String() }),
  async execute(args) {
    return {
      content: [{ type: "text", text: `echo:${String(args["msg"] ?? "")}` }],
    };
  },
};

/** 固定错误文案的干活工具——同参数反复调用产生「同工具同错误」。 */
const boomTool: HarnessTool = {
  name: "boom",
  description: "干活工具（测试用），boom* 输入总是抛固定错误",
  parameters: Type.Object({ msg: Type.String() }),
  async execute(args) {
    const msg = String(args["msg"] ?? "");
    if (msg.startsWith("boom")) throw new Error("boom#1 固定失败");
    return { content: [{ type: "text", text: `boom-ok:${msg}` }] };
  },
};

/** 按参数抛**不同**错误的干活工具（验证升级键 = 工具 + 错误文本）。 */
const flakyTool: HarnessTool = {
  name: "flaky",
  description: "干活工具（测试用），按参数抛不同错误",
  parameters: Type.Object({ msg: Type.String() }),
  async execute(args) {
    throw new Error(`flaky-fail:${String(args["msg"] ?? "")}`);
  },
};

const textTurn = (t: string): FakeAssistantResponse => ({
  content: [{ type: "text", text: t }],
});
const workTurn = (msg: string): FakeAssistantResponse => ({
  content: [{ type: "toolCall", name: "echo", arguments: { msg } }],
});
const boomTurn = (msg: string): FakeAssistantResponse => ({
  content: [{ type: "toolCall", name: "boom", arguments: { msg } }],
});
const flakyTurn = (msg: string): FakeAssistantResponse => ({
  content: [{ type: "toolCall", name: "flaky", arguments: { msg } }],
});

const MAIN_OK = {
  status: "已完成" as const,
  digest: "已完成：全部 12 项健康检查通过，无待处置异常",
  body: "本轮巡检摘要：磁盘/网关/任务队列全部正常。",
};
const SIDE_OK = {
  status: "done" as const,
  runId: "run-42",
  workflow: "nightly-audit",
  attempt: 1,
  digest: "done：审计产物 3 件全部落盘并通过预验",
  pointers: ["git:abc123", "file:ai/data/audit.json"],
};

function convergeTurn(
  args: Record<string, unknown>,
  withBody: boolean,
): FakeAssistantResponse {
  const blocks: FakeAssistantResponse["content"] = [];
  if (withBody) blocks.push({ type: "text", text: "正文：本轮结论如下。" });
  blocks.push({ type: "toolCall", name: "converge", arguments: args });
  return { content: blocks };
}

type FakeModel = ReturnType<typeof createFakeModel>;

function makeSession(
  model: FakeModel,
  gate: ConvergenceGate,
  extraTools: HarnessTool[],
  extraHooks: Hook[],
): AgentSession {
  return new AgentSession({
    model,
    tools: [gate.tool, ...extraTools],
    hooks: [...gate.buildHooks(), ...extraHooks],
    logSink: quietSink,
    consoleSink: quietSink,
  });
}

function setupMain(model: FakeModel, extraTools: HarnessTool[] = [], limits?: Limits) {
  const gate = new ConvergenceGate({
    kind: "main",
    ...(limits === undefined ? {} : { limits }),
  });
  return { gate, session: makeSession(model, gate, extraTools, []) };
}

function setupSide(model: FakeModel, limits?: Limits) {
  const gate = new ConvergenceGate({
    kind: "side",
    ...(limits === undefined ? {} : { limits }),
  });
  return { gate, session: makeSession(model, gate, [], []) };
}

/* ────────────── Tests ────────────── */

describe("收束终止机制（D25/D26/D30/D31）", () => {
  it("(a) 纯文本结束不终止会话——gate 持续催办，绝不因无 toolCall 而停", async () => {
    const model = createFakeModel([
      textTurn("第一段纯文本，自以为说完了"),
      textTurn("第二段纯文本，还是没收束"),
      textTurn("第三段纯文本，继续装忙"),
      textTurn("第四段纯文本，依然不收束"),
      textTurn("第五段纯文本，死也不收束"),
      textTurn("第六段纯文本，等升级"),
    ]);
    const { gate, session } = setupMain(model);
    const summary = await session.run("汇报一下健康状态");

    // 内核本会在每个「无 toolCall」turn 后自然停止；gate 用续跑闸把会话继续维持着。
    expect(summary.continuations).toBeGreaterThan(0);
    // 纯文本绝不构成终止证据：没有任何 converged 回执。
    expect(
      markerResults(session.messages).filter((r) => r.converged),
    ).toHaveLength(0);
    // 催办是**持久**消息（进 session.messages），不是 transient 摆设。
    expect(countMarks(allText(session.messages), NUDGE_MARK)).toBe(5);
    // 被催后模型在下一次 LLM call 的 context 里确实看得见催办。
    const seen = model.getCalls();
    expect(seen.length).toBeGreaterThanOrEqual(2);
    const secondCall = nth(seen, 1);
    expect(
      secondCall.messages.some((m) =>
        textOf((m as { content?: unknown }).content).includes(NUDGE_MARK),
      ),
    ).toBe(true);
    // 空转到催办预算用尽 → 升级强制收束（绝不静默假完成）。
    const outcome = requireOutcome(gate.runOutcome().outcome);
    expect(describeOutcome(outcome)).toBe("forceEnded:nudge-limit:需用户确认");
    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toContain("convergence");
  });

  it("(b) 字段不齐的收束调用 → 催办；连续 5 次不收敛 → 升级强制收束（主=需用户确认）", async () => {
    const missingFields = {} as Record<string, unknown>; // 缺必填 status（digest 已自动派生、body 可省略）
    const model = createFakeModel([
      convergeTurn(missingFields, false), // turn0：schema 必填缺失 → 催办 1
      textTurn("解释一"), // 想以纯文本停 → 催办 2..5
      textTurn("解释二"),
      textTurn("解释三"),
      textTurn("解释四"),
      textTurn("解释五"), // 第 5 次催办后的下一 turn → 升级强制收束
    ]);
    const { gate, session } = setupMain(model);
    const summary = await session.run("干活");

    // 恰 5 次催办——不多不少；催办编号带进度（1/5）。
    const text = allText(session.messages);
    expect(countMarks(text, NUDGE_MARK)).toBe(5);
    expect(text).toContain("1/5");
    expect(text).not.toContain("6/5");

    // 收束尝试失败不算成功收束（isError 回灌），也不产生 converged。
    expect(
      markerResults(session.messages).filter((r) => r.converged),
    ).toHaveLength(0);

    // 升级 = 分级强制收束：一条**如实**的合成回执（status=需用户确认），绝不「已完成」假完成。
    const forced = markerResults(session.messages).filter((r) => !r.converged);
    expect(forced).toHaveLength(1);
    expect((forced[0]?.receipt as MainReceipt).status).toBe("需用户确认");
    const outcome = requireOutcome(gate.runOutcome().outcome);
    expect(describeOutcome(outcome)).toBe("forceEnded:nudge-limit:需用户确认");
    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toContain("convergence");
    expect(receiptsOf(session.messages)).toHaveLength(1);
  });

  it("(c) 同工具同错误 ×3 → 升级提示恰一次；会话继续，直到真实收束", async () => {
    const model = createFakeModel([
      boomTurn("boom#1"),
      boomTurn("boom#1"),
      boomTurn("boom#1"), // 第 3 次同错 → 升级
      boomTurn("ok-now"), // 不再报错，不重复升级
      convergeTurn(MAIN_OK, true),
    ]);
    const { gate, session } = setupMain(model, [boomTool]);
    const summary = await session.run("执行任务");

    const outcomes = gate.runOutcome().outcomes;
    const escalated = outcomes.filter((o) => o.type === "escalated");
    expect(escalated).toHaveLength(1);
    expect(describeOutcome(nth(escalated, 0))).toBe("escalated:boom");
    expect(countMarks(allText(session.messages), ESCALATE_MARK)).toBe(1);

    // 升级是提示不是终止：会话最终由**真实**收束盖棺（收敛后本轮终止）。
    expect(
      markerResults(session.messages).filter((r) => r.converged),
    ).toHaveLength(1);
    expect(summary.reason).toBe("aborted"); // 收束 turn 含 toolCall → gate 盖棺（loop 内 abort）
    expect(summary.abortReason).toContain("convergence:converged");
    expect(summary.continuations).toBe(0);
  });

  it("(c2) 同工具**不同**错误不触发升级（键 = 工具 + 错误文本）", async () => {
    const model = createFakeModel([
      flakyTurn("a"),
      flakyTurn("b"),
      flakyTurn("c"),
      flakyTurn("d"),
      convergeTurn(MAIN_OK, true),
    ]);
    const { gate, session } = setupMain(model, [flakyTool]);
    await session.run("执行任务");
    expect(
      gate.runOutcome().outcomes.filter((o) => o.type === "escalated"),
    ).toHaveLength(0);
    expect(allText(session.messages)).not.toContain(ESCALATE_MARK);
  });

  it("(c3) 阈值从注入 Limits 实时读：热载 3→2 后，第 2 次同错即升级（冻结 3 则不会）", async () => {
    const limits: Limits = { ...DEFAULT_LIMITS };
    // t0 报错时阈值仍是 3（count=1 不升级）；t0 的 onTurnEnd 之后热载改成 2；
    // t1 报错 count=2>=2 → 升级发生在第 2 次——只有「事件时刻现读」才可能。
    const model = createFakeModel([
      boomTurn("boom#1"),
      boomTurn("boom#1"), // 热载后第 2 次同错 → 升级
      boomTurn("ok-now"),
      convergeTurn(MAIN_OK, true),
    ]);
    const gate = new ConvergenceGate({ kind: "main", limits });
    const flipper: Hook = {
      name: "limit-flipper",
      onTurnStart(_input, _ctx) {
        if (model.getCalls().length >= 1) limits.escalateSameError = 2;
      },
    };
    const session = makeSession(model, gate, [boomTool], [flipper]);
    await session.run("执行任务");

    const escalated = gate.runOutcome().outcomes.filter(
      (o) => o.type === "escalated",
    );
    expect(escalated).toHaveLength(1);
    const first = nth(escalated, 0);
    if (first.type !== "escalated") throw new Error("unreachable");
    expect(first.attempt).toBe(2); // 冻结值 3 时绝不会是 2
    expect(
      markerResults(session.messages).filter((r) => r.converged),
    ).toHaveLength(1);
  });

  it("(d) 轮数硬顶（limits.turnHardCap=4）→ 第 4 turn 末强制收束 需用户确认", async () => {
    const model = createFakeModel(
      Array.from({ length: 12 }, (_, i) => workTurn(`w${i}`)),
    );
    const { gate, session } = setupMain(model, [echoTool], {
      ...DEFAULT_LIMITS,
      turnHardCap: 4,
    });
    const summary = await session.run("一直干活永远不收束");

    expect(summary.turns).toBe(4);
    expect(model.getCalls()).toHaveLength(4); // 第 5 次 LLM call 被硬顶掐死
    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toContain("convergence");
    expect(
      markerResults(session.messages).filter((r) => r.converged),
    ).toHaveLength(0);
    const forced = markerResults(session.messages).filter((r) => !r.converged);
    expect(forced).toHaveLength(1);
    const receipt = forced[0]?.receipt as MainReceipt;
    expect(receipt.status).toBe("需用户确认");
    expect(receipt.digest).toContain("轮数硬顶");
    expect(requireOutcome(gate.runOutcome().outcome)).toSatisfy(
      (o: ConvergenceOutcome) =>
        describeOutcome(o) === "forceEnded:turn-hard-cap:需用户确认",
    );
  });

  it("(d2) 副会话轮数硬顶 → 强制收束 status=failed + 死信投主标记", async () => {
    const model = createFakeModel(
      Array.from({ length: 12 }, (_, i) => workTurn(`w${i}`)),
    );
    const { gate, session } = setupSide(model, {
      ...DEFAULT_LIMITS,
      turnHardCap: 3,
    });
    const summary = await session.run("执行工作流 run-99");
    expect(summary.reason).toBe("aborted");
    const outcome = requireOutcome(gate.runOutcome().outcome);
    expect(describeOutcome(outcome)).toBe("forceEnded:turn-hard-cap:failed");
    if (outcome.type !== "forceEnded") throw new Error("unreachable");
    expect(outcome.deadLetter).toBe(true);
    const forced = markerResults(session.messages).filter((r) => !r.converged);
    expect(forced).toHaveLength(1);
    expect((forced[0]?.receipt as SideReceipt).status).toBe("failed");
    expect(allText(session.messages)).toContain(DEAD_LETTER_MARK);
  });

  it("(e) 正文+干活工具+收束同轮 → 全部执行、一次 LLM call 终止（零额外往返）", async () => {
    const model = createFakeModel([
      // 单轮混用：正文 + 干活 + 字段齐全的收束——干活与收束都执行，收束照常受理。
      {
        content: [
          { type: "text", text: "正文：本轮边干活边收束。" },
          { type: "toolCall", name: "echo", arguments: { msg: "w" } },
          { type: "toolCall", name: "converge", arguments: { ...MAIN_OK } },
        ],
      },
    ]);
    const { gate, session } = setupMain(model, [echoTool]);
    const summary = await session.run("干活然后收束");

    // 零额外往返：混合轮一次 LLM call 即终止，不再要求下一轮补收束。
    expect(model.getCalls()).toHaveLength(1);
    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toContain("convergence:converged");

    // 干活工具照常执行（同批串行：echo → converge），错误不吞、结果可读。
    const echoResults = session.messages.filter(
      (m) => m.role === "toolResult" && m.toolName === "echo",
    );
    expect(echoResults).toHaveLength(1);
    const echoResult = nth(echoResults, 0);
    if (echoResult.role !== "toolResult") throw new Error("unreachable");
    expect(echoResult.isError).toBe(false);
    expect(textOf(echoResult.content)).toContain("echo:w");

    // 恰一条真实收束回执；同轮混用不产生任何催办。
    expect(
      markerResults(session.messages).filter((r) => r.converged),
    ).toHaveLength(1);
    expect(
      gate.runOutcome().outcomes.filter((o) => o.type === "nudged"),
    ).toHaveLength(0);
  });

  it("(e2) 正文+收束同轮成功：converged 回执落盘、本轮到此结束（单次 LLM call 即终止）", async () => {
    const model = createFakeModel([convergeTurn(MAIN_OK, true)]);
    const { gate, session } = setupMain(model);
    const summary = await session.run("干活然后收束");

    // 零额外往返：整个 run 只有 1 次 LLM call——正文和收束在同一 assistant 轮给全。
    expect(model.getCalls()).toHaveLength(1);
    expect(summary.continuations).toBe(0);
    expect(summary.reason).toBe("aborted"); // 收束盖棺的唯一内核通道（toolUse turn 不会自然 done）
    expect(summary.abortReason).toContain("convergence:converged:已完成");
    expect(summary.turns).toBe(1);

    const outcome = requireOutcome(gate.runOutcome().outcome);
    expect(describeOutcome(outcome)).toBe("converged:已完成");

    const results = markerResults(session.messages);
    expect(results).toHaveLength(1);
    const first = results[0];
    if (first === undefined || !first.converged) throw new Error("no converged marker");
    expect(first.receipt).toEqual({
      status: MAIN_OK.status,
      digest: MAIN_OK.digest,
      body: MAIN_OK.body,
      pointers: [],
      blockers: [],
    });
  });

  it("(e3) 副会话成功收束：done 批次回执（runId/workflow/attempt/pointers）落盘", async () => {
    const model = createFakeModel([convergeTurn({ ...SIDE_OK }, true)]);
    const { gate, session } = setupSide(model);
    await session.run("执行工作流 run-42");

    expect(describeOutcome(requireOutcome(gate.runOutcome().outcome))).toBe(
      "converged:done",
    );
    const receipt = receiptsOf(session.messages)[0];
    if (receipt === undefined) throw new Error("no receipt");
    expect(receipt).toEqual({
      status: "done",
      runId: "run-42",
      workflow: "nightly-audit",
      attempt: 1,
      digest: SIDE_OK.digest,
      pointers: SIDE_OK.pointers,
      blockers: [],
    });
  });

  it("ConvergenceOutcome 判别联合：五种变体均可被 exhaustive switch 处理", () => {
    const cases: ConvergenceOutcome[] = [
      {
        type: "converged",
        status: "已完成",
        receipt: { ...MAIN_OK, pointers: [], blockers: [] },
      },
      { type: "nudged", reason: "duplicate", nudgeCount: 1 },
      {
        type: "escalated",
        tool: "boom",
        errorText: "boom#1 固定失败",
        attempt: 3,
      },
      {
        type: "forceEnded",
        reason: "turn-hard-cap",
        receipt: {
          status: "需用户确认",
          digest: "触发轮数硬顶，已自动收束",
          body: "卡在轮数硬顶。",
          pointers: [],
          blockers: ["轮数硬顶"],
        },
        deadLetter: false,
      },
      { type: "continued", nudgeCount: 2 },
    ];
    expect(cases.map(describeOutcome)).toEqual([
      "converged:已完成",
      "nudged:duplicate",
      "escalated:boom",
      "forceEnded:turn-hard-cap:需用户确认",
      "continued:2",
    ]);
  });

  it("Limits 默认值 = 冻结值（催办5/同错3/硬顶60/自动续跑2），gate.limits 实时引用注入对象", () => {
    expect(DEFAULT_LIMITS).toEqual({
      nudgeLimit: 5,
      escalateSameError: 3,
      turnHardCap: 60,
      autoContinuations: 2,
    });
    const limits: Limits = { ...DEFAULT_LIMITS };
    const gate = new ConvergenceGate({ kind: "main", limits });
    expect(gate.limits).toBe(limits); // 同一引用——热载改字段即刻生效，gate 不快照
    limits.nudgeLimit = 2;
    expect(gate.limits.nudgeLimit).toBe(2);
    expect(new ConvergenceGate({ kind: "side" }).limits).toEqual(DEFAULT_LIMITS);
  });

  it("gate 暴露 T10 接线契约：minKernelBudget / isConvergedTermination", async () => {
    const model = createFakeModel([convergeTurn(MAIN_OK, true)]);
    const { gate, session } = setupMain(model);
    // 内核 maxContinuations 必须 >= nudgeLimit，否则续跑催办被内核预算掐死前
    // 无法催满——gate 把最小预算暴露给 T10 校验。
    expect(gate.minKernelBudget()).toBe(DEFAULT_LIMITS.nudgeLimit);
    const summary = await session.run("干活");
    expect(gate.isConvergedTermination(session.id, summary.abortReason)).toBe(
      "converged",
    );
    const other = new ConvergenceGate({ kind: "main" });
    expect(other.isConvergedTermination(session.id, "watchdog timeout")).toBe(
      "not-converged",
    );
  });
});
