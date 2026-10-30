/**
 * T09 收束机制 —— 对抗性攻击面（每个静默假污染的入口都要有测试钉死）：
 *
 *   A1 模型谎称收束（字段全但内容空/whitespace/非整数 attempt）→ 语义层拒收，不 converged。
 *   A2 kind 越界收束（副会话用主三态 / 主会话用 side 枚举）→ schema 拒收 + 计数。
 *   A3 收束循环振荡（同轮重复 converge / 收束后再调 converge）→ 只受理一次，盖棺后零 LLM call。
 *   A4' 缺字段+干活工具同轮刷催办 → 催办满 5 照样升级强制收束，不无限空转（干活工具每轮照常执行）。
 *   A5 nudge 注入被模型当普通文本忽略 → 纯文本无视催办持续空转，照样在限额内被强制收束且回执如实。
 *   A6 强制收束回执诚实性（主≠已完成；副 failed+deadLetter）。
 *   A7 alias 调用等价（converge-main/converge-side 视作收束调用）。
 */

import { describe, expect, it } from "vitest";
import {
  AgentSession,
  ConvergenceGate,
  DEFAULT_LIMITS,
  Type,
  type ConvergenceOutcome,
  type HarnessTool,
  type Limits,
  type MainReceipt,
  type Message,
  type SideReceipt,
} from "../index.js";
import { createFakeModel, type FakeAssistantResponse } from "../testing.js";

const NUDGE_MARK = "【收束催办】";

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
  return messages.map((m) => textOf((m as { content?: unknown }).content)).join("\n");
}

function countMarks(text: string, mark: string): number {
  return text.split(mark).length - 1;
}

interface MarkerResult {
  converged: boolean;
  outcome: ConvergenceOutcome;
  receipt?: MainReceipt | SideReceipt;
  deadLetter?: boolean;
}

const CONVERGE_NAMES: readonly string[] = ["converge", "converge-main", "converge-side"];

function markerResults(messages: ReadonlyArray<Message>): MarkerResult[] {
  const out: MarkerResult[] = [];
  for (const m of messages) {
    if (m.role === "toolResult" && CONVERGE_NAMES.includes(m.toolName)) {
      const d = (m as { details?: { __convergence?: MarkerResult } }).details;
      if (d !== undefined && d.__convergence !== undefined) out.push(d.__convergence);
    }
    if (m.role === "user") {
      const meta = (m as { _meta?: { kind?: string; result?: MarkerResult } })._meta;
      if (meta !== undefined && meta.kind === "convergence_receipt" && meta.result !== undefined) {
        out.push(meta.result);
      }
    }
  }
  return out;
}

function quietSink(): void {
  /* noop */
}

const echoTool: HarnessTool = {
  name: "echo",
  description: "干活工具（测试用）",
  parameters: Type.Object({ msg: Type.String() }),
  async execute(args) {
    return { content: [{ type: "text", text: `echo:${String(args["msg"] ?? "")}` }] };
  },
};

const MAIN_OK = {
  status: "已完成" as const,
  digest: "已完成：全部检查通过",
  body: "巡检正常，无异常。",
};
const SIDE_OK = {
  status: "done" as const,
  runId: "run-7",
  workflow: "wf-x",
  attempt: 1,
  digest: "done：产物落盘",
  pointers: ["file:a"],
};

function convergeTurn(args: Record<string, unknown>, name = "converge"): FakeAssistantResponse {
  return {
    content: [
      { type: "text", text: "正文。" },
      { type: "toolCall", name, arguments: args },
    ],
  };
}

function makeMain(model: ReturnType<typeof createFakeModel>, limits?: Limits) {
  const gate = new ConvergenceGate({ kind: "main", ...(limits === undefined ? {} : { limits }) });
  const session = new AgentSession({
    model,
    tools: [gate.tool, echoTool],
    hooks: gate.buildHooks(),
    maxTurns: 100,
    maxContinuations: limits?.nudgeLimit ?? DEFAULT_LIMITS.nudgeLimit,
    logSink: quietSink,
    consoleSink: quietSink,
  });
  return { gate, session };
}

function makeSide(model: ReturnType<typeof createFakeModel>, limits?: Limits) {
  const gate = new ConvergenceGate({ kind: "side", ...(limits === undefined ? {} : { limits }) });
  const session = new AgentSession({
    model,
    tools: [gate.tool],
    hooks: gate.buildHooks(),
    maxTurns: 100,
    maxContinuations: limits?.nudgeLimit ?? DEFAULT_LIMITS.nudgeLimit,
    logSink: quietSink,
    consoleSink: quietSink,
  });
  return { gate, session };
}

describe("收束机制对抗性攻击面", () => {
  it("A1 字段全但语义空壳（非法 wake、非法 blockers、attempt=1.5）→ 拒收不 converged，真实收束才盖棺", async () => {
    const model = createFakeModel([
      convergeTurn({ status: "已完成", wake: "garbage" }), // 非法 wake → 语义拒
      convergeTurn({ status: "已完成", digest: "ok", body: "ok", pointers: ["p"], blockers: "nope" }), // 类型错
      convergeTurn(MAIN_OK), // 真实收束
    ]);
    const { gate, session } = makeMain(model);
    const summary = await session.run("干活");

    expect(
      markerResults(session.messages).filter((r) => r.converged),
    ).toHaveLength(1);
    expect(gate.runOutcome().outcomes.filter((o) => o.type === "nudged" && o.reason === "fields")).toHaveLength(2);
    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toContain("convergence:converged");
    expect(model.getCalls()).toHaveLength(3);
  });

  it("A1b 副会话 attempt=1.5 过 TypeBox 但被语义层拒；attempt=1 受理", async () => {
    const model = createFakeModel([
      convergeTurn({ ...SIDE_OK, attempt: 1.5 }),
      convergeTurn(SIDE_OK),
    ]);
    const { gate, session } = makeSide(model);
    await session.run("wf");
    expect(
      markerResults(session.messages).filter((r) => r.converged),
    ).toHaveLength(1);
    const receipt = markerResults(session.messages).find((r) => r.converged)?.receipt as SideReceipt;
    expect(receipt.attempt).toBe(1);
    expect(gate.runOutcome().outcomes.some((o) => o.type === "nudged" && o.reason === "fields")).toBe(true);
  });

  it("A2 kind 越界：副会话交主三态 → schema 拒收；主会话交 side 枚举 → schema 拒收", async () => {
    const sideModel = createFakeModel([
      convergeTurn({ status: "已完成", digest: "x", body: "y" }), // side 不接受中文三态
      convergeTurn(SIDE_OK),
    ]);
    const side = makeSide(sideModel);
    await side.session.run("wf");
    expect(
      markerResults(side.session.messages).filter((r) => r.converged),
    ).toHaveLength(1);
    expect(side.gate.runOutcome().outcomes.some((o) => o.type === "nudged" && o.reason === "fields")).toBe(true);

    const mainModel = createFakeModel([
      convergeTurn({ status: "done", digest: "x", body: "y" }), // main 不接受 side 枚举
      convergeTurn(MAIN_OK),
    ]);
    const main = makeMain(mainModel);
    await main.session.run("go");
    expect(
      markerResults(main.session.messages).filter((r) => r.converged),
    ).toHaveLength(1);
  });

  it("A3 振荡防护：同轮重复 converge 只受理一次；盖棺后零额外 LLM call", async () => {
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "converge", arguments: { ...MAIN_OK } },
          { type: "toolCall", name: "converge", arguments: { ...MAIN_OK, digest: "第二次" } },
        ],
      },
      convergeTurn(MAIN_OK), // 永远不该被消费
    ]);
    const { gate, session } = makeMain(model);
    const summary = await session.run("干活");

    expect(model.getCalls()).toHaveLength(1); // 盖棺即停，第二脚本未跑
    const converged = markerResults(session.messages).filter((r) => r.converged);
    expect(converged).toHaveLength(1);
    expect(converged[0]?.receipt).toSatisfy(
      (r: MainReceipt | SideReceipt | undefined) =>
        r !== undefined && (r as MainReceipt).digest === MAIN_OK.digest,
    );
    expect(summary.abortReason).toContain("convergence:converged");
    expect(gate.runOutcome().outcome?.type).toBe("converged");
  });

  it("A4' 缺字段+干活工具同轮刷催办：每轮 echo 照常执行，5 次后强制分级收束（不无限空转）", async () => {
    const badTurn = (): FakeAssistantResponse => ({
      content: [
        { type: "toolCall", name: "echo", arguments: { msg: "w" } },
        { type: "toolCall", name: "converge", arguments: { status: "已完成", wake: "garbage" } },
      ],
    });
    const model = createFakeModel([badTurn(), badTurn(), badTurn(), badTurn(), badTurn(), badTurn(), badTurn()]);
    const { gate, session } = makeMain(model);
    const summary = await session.run("干活");

    expect(model.getCalls()).toHaveLength(5); // 恰在催办满 5 的那轮强制
    expect(summary.reason).toBe("aborted");
    expect(summary.abortReason).toContain("convergence:nudge-limit");
    const outcome = gate.runOutcome().outcome;
    if (outcome === null || outcome.type !== "forceEnded") throw new Error("expected forceEnded");
    expect((outcome.receipt as MainReceipt).status).toBe("需用户确认");
    expect(
      markerResults(session.messages).filter((r) => r.converged),
    ).toHaveLength(0); // 缺字段的收束永远不算收束
    // 混用不再拒干活工具：5 轮各执行一次 echo，全部成功。
    const echoResults = session.messages.filter(
      (m) => m.role === "toolResult" && m.toolName === "echo",
    );
    expect(echoResults).toHaveLength(5);
    for (const r of echoResults) {
      if (r.role !== "toolResult") throw new Error("unreachable");
      expect(r.isError).toBe(false);
    }
  });

  it("A5 催办被模型当普通文本忽略：持续纯文本空转 → 限额内强制收束，回执如实说明未收束", async () => {
    const model = createFakeModel(
      Array.from({ length: 8 }, (_, i) => ({
        content: [{ type: "text", text: `无视催办第${i}次，继续输出文本。` }],
      })),
    );
    const { gate, session } = makeMain(model);
    const summary = await session.run("干活");

    expect(summary.continuations).toBeGreaterThan(0);
    expect(summary.reason).toBe("aborted");
    const outcome = gate.runOutcome().outcome;
    if (outcome === null || outcome.type !== "forceEnded") throw new Error("expected forceEnded");
    expect(outcome.receipt.status).toBe("需用户确认");
    expect(outcome.receipt.digest).toContain("催办");
    // 每条催办都持久进了 messages（不是 transient），模型每轮都收到。
    expect(countMarks(allText(session.messages), NUDGE_MARK)).toBe(5);
  });

  it("A6 强制收束诚实性：主会话强制绝不出现「已完成」；副会话强制=failed+deadLetter+死信标记", async () => {
    const mainModel = createFakeModel([
      convergeTurn({ status: "已完成", wake: "garbage" }), // 非法 wake
      { content: [{ type: "text", text: "继续装死" }] },
      { content: [{ type: "text", text: "继续装死" }] },
      { content: [{ type: "text", text: "继续装死" }] },
      { content: [{ type: "text", text: "继续装死" }] },
    ]);
    const main = makeMain(mainModel);
    await main.session.run("go");
    const mainOutcome = main.gate.runOutcome().outcome;
    if (mainOutcome === null || mainOutcome.type !== "forceEnded") {
      throw new Error("expected forceEnded (main)");
    }
    expect(mainOutcome.receipt.status).not.toBe("已完成");
    expect(mainOutcome.deadLetter).toBe(false);

    const sideModel = createFakeModel(
      Array.from({ length: 6 }, () => ({
        content: [{ type: "toolCall", name: "echo", arguments: { msg: "w" } }],
      })),
    );
    // 副会话没注册 echo → unknown tool 错误回灌，turn 照常推进；limits 缩到 nudge 无关，走硬顶。
    const sideGate = new ConvergenceGate({ kind: "side", limits: { ...DEFAULT_LIMITS, turnHardCap: 2 } });
    const sideSession = new AgentSession({
      model: sideModel,
      tools: [sideGate.tool],
      hooks: sideGate.buildHooks(),
      maxTurns: 50,
      logSink: quietSink,
      consoleSink: quietSink,
    });
    await sideSession.run("wf");
    const sideOutcome = sideGate.runOutcome().outcome;
    if (sideOutcome === null || sideOutcome.type !== "forceEnded") {
      throw new Error("expected forceEnded (side)");
    }
    expect(sideOutcome.receipt.status).toBe("failed");
    expect(sideOutcome.deadLetter).toBe(true);
    expect(allText(sideSession.messages)).toContain("【死信】");
  });

  it("A7 alias 等价：converge-main/converge-side 视作收束；与干活工具同轮混用照常受理", async () => {
    const model = createFakeModel([convergeTurn(MAIN_OK, "converge-main")]);
    const { gate, session } = makeMain(model);
    const summary = await session.run("干活");
    expect(summary.abortReason).toContain("convergence:converged");
    expect(gate.runOutcome().outcome?.type).toBe("converged");

    // 别名收束与干活工具同轮：同批全部执行，收束照常受理。
    const mixedModel = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "echo", arguments: { msg: "w" } },
          { type: "toolCall", name: "converge-main", arguments: { ...MAIN_OK } },
        ],
      },
    ]);
    const mixed = makeMain(mixedModel);
    const mixedSummary = await mixed.session.run("干活");
    expect(mixedModel.getCalls()).toHaveLength(1);
    expect(mixedSummary.abortReason).toContain("convergence:converged");
    expect(
      markerResults(mixed.session.messages).filter((r) => r.converged),
    ).toHaveLength(1);
    expect(mixed.gate.runOutcome().outcome?.type).toBe("converged");
  });

  it("A8 收束成功但内核侧防误判：非收束 abort 不被 isConvergedTermination 误认 converged", async () => {
    const model = createFakeModel([
      convergeTurn(MAIN_OK),
    ]);
    const { gate, session } = makeMain(model);
    const summary = await session.run("干活");
    expect(gate.isConvergedTermination(session.id, summary.abortReason)).toBe("converged");
    expect(gate.isConvergedTermination(session.id, undefined)).toBe("not-converged");
    expect(gate.isConvergedTermination("other-session", "convergence:converged:已完成")).toBe("not-converged");
  });
});
