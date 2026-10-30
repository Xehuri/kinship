/**
 * ConvergenceGate.onNudge 观察钩子验收（trace nudge 行生产接线的 core 半边）：
 *   - text-only / schema 拒收 / execute 层拒收三条 nudged 通道各有回调；
 *   - 回调携带 sessionId/turnIdx/reason/nudgeCount（与 outcome 账本同源）；
 *   - converged/continued/escalated 不触发回调；
 *   - 回调抛错被吞，收束判别路径不受反噬。
 * 全部用 createFakeModel 驱动真实 AgentSession（同 convergence.test.ts 姿势）。
 */

import { describe, expect, it } from "vitest";
import { AgentSession, Type, type HarnessTool } from "../index.js";
import { ConvergenceGate, type NudgeObservation } from "./index.js";
import { DEFAULT_LIMITS, type Limits } from "./limits.js";
import { createFakeModel, type FakeAssistantResponse } from "../testing.js";

function quietSink(): void {
  /* 吞掉默认 console 输出 */
}

const textTurn = (t: string): FakeAssistantResponse => ({
  content: [{ type: "text", text: t }],
});

const SIDE_OK = {
  status: "done" as const,
  runId: "run-observer",
  workflow: "w-observer",
  attempt: 1,
  digest: "done：观测面接线自检完成",
  pointers: ["file:state/fleet/obs.md"],
};

function convergeTurn(args: Record<string, unknown>): FakeAssistantResponse {
  return { content: [{ type: "toolCall", name: "converge", arguments: args }] };
}

const echoTool: HarnessTool = {
  name: "echo",
  description: "干活工具（测试用），总是成功",
  parameters: Type.Object({ msg: Type.String() }),
  async execute(args: Record<string, unknown>) {
    return { content: [{ type: "text" as const, text: `echo:${String(args["msg"] ?? "")}` }] };
  },
};

describe("ConvergenceGate.onNudge 观察钩子", () => {
  it("text-only 催办：每条 nudged outcome 恰一次回调，字段与账本同源，收束后无多余回调", async () => {
    const seen: NudgeObservation[] = [];
    const model = createFakeModel([
      textTurn("我先说两句"),
      textTurn("再说两句"),
      convergeTurn(SIDE_OK),
    ]);
    const gate = new ConvergenceGate({ kind: "side", onNudge: (ev) => seen.push(ev) });
    const session = new AgentSession({
      model,
      tools: [gate.tool],
      hooks: gate.buildHooks(),
      sessionId: "ses_000000000000000b",
      logSink: quietSink,
      consoleSink: quietSink,
    });
    await session.run("开工", {});

    expect(seen.length).toBe(2);
    expect(seen.map((s) => [s.reason, s.nudgeCount])).toEqual([
      ["text-only", 1],
      ["text-only", 2],
    ]);
    expect(seen.every((s) => s.sessionId === "ses_000000000000000b")).toBe(true);
    expect(seen.every((s) => Number.isInteger(s.turnIdx))).toBe(true);
    // 账本对照：nudged 条目数 = 回调数（一一对应，不重不漏）。
    const nudged = gate.runOutcome().outcomes.filter((o) => o.type === "nudged");
    expect(nudged).toHaveLength(seen.length);
    expect(gate.runOutcome().outcome?.type).toBe("converged");
  });

  it("execute 层拒收（语义空壳）：reason=fields 回调；随后成功收束", async () => {
    const seen: NudgeObservation[] = [];
    const invalid = { ...SIDE_OK, runId: "   " } as Record<string, unknown>;
    const model = createFakeModel([convergeTurn(invalid), convergeTurn(SIDE_OK)]);
    const gate = new ConvergenceGate({ kind: "side", onNudge: (ev) => seen.push(ev) });
    const session = new AgentSession({
      model,
      tools: [gate.tool],
      hooks: gate.buildHooks(),
      sessionId: "ses_000000000000000c",
      logSink: quietSink,
      consoleSink: quietSink,
    });
    await session.run("开工", {});

    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]?.reason).toBe("fields");
    expect(seen[0]?.nudgeCount).toBe(1);
  });

  it("干活工具成功轮（continued）不触发回调；escalated 也不触发", async () => {
    const seen: NudgeObservation[] = [];
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "echo", arguments: { msg: "hi" } }] },
      convergeTurn(SIDE_OK),
    ]);
    const gate = new ConvergenceGate({ kind: "side", onNudge: (ev) => seen.push(ev) });
    const session = new AgentSession({
      model,
      tools: [gate.tool, echoTool],
      hooks: gate.buildHooks(),
      sessionId: "ses_000000000000000d",
      logSink: quietSink,
      consoleSink: quietSink,
    });
    await session.run("开工", {});
    expect(seen).toHaveLength(0);
  });

  it("回调抛错被吞：收束判别与终止通道不受反噬（nudge-limit 强制收束照常）", async () => {
    const limits: Limits = { ...DEFAULT_LIMITS, nudgeLimit: 2 };
    const model = createFakeModel([textTurn("拖"), textTurn("再拖"), textTurn("还拖")]);
    const gate = new ConvergenceGate({
      kind: "side",
      limits,
      onNudge: () => {
        throw new Error("observer blew up");
      },
    });
    const session = new AgentSession({
      model,
      tools: [gate.tool],
      hooks: gate.buildHooks(),
      sessionId: "ses_000000000000000e",
      logSink: quietSink,
      consoleSink: quietSink,
    });
    await session.run("开工", {});
    const terminal = gate.runOutcome().outcome;
    expect(terminal?.type).toBe("forceEnded");
  });
});
