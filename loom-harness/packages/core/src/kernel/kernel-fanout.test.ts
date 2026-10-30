/**
 * W9 切片 2 —— 内核在飞册 + task 门面委托验收。
 * Given: SpawnKernel（MemoryLedger + dummy 端口）与 createTaskTool(fanout=内核视图) 组合，
 *        另备不传 fanout 的旧局部计数面回归组
 * When:  两路真 AgentSession（模拟主/副门面）共用同一 task 工具实例并发派慢子；池原语直调
 * Then:  池=构建入册/终态出册，跨门面第二路 fail-loud 文案逐字（"fan-out limit
 *        (maxFanout=1) reached (1 in flight)"）、全局数 kernel 侧可见、归零可复用；
 *        registerSub 撞号响亮抛、releaseSub 幂等 false、spawn(sub) 不触账本（分册）；
 *        不传 fanout 的旧面行为逐字节不变（subagent.test 24 测同型的本地并发拒绝仍生效）。
 */

import { describe, expect, it } from "vitest";
import { AgentSession, MemorySessionStore } from "../index.js";
import { createFakeModel, type FakeAssistantResponse } from "../testing.js";
import { builtinAgentTypes } from "../subagent/agents.js";
import { createTaskTool } from "../subagent/task-tool.js";
import { MemoryLedger } from "../run-engine/memory-ledger.js";
import { SpawnKernel } from "./kernel.js";
import type { RunLaunchResult } from "../run-engine/types.js";

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("waitFor: budget exhausted");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** toolResult 文本+isError 观测面（与 subagent.test 的 toolResults 同型）。 */
function toolResults(session: AgentSession): Array<{ text: string; isError: boolean }> {
  const out: Array<{ text: string; isError: boolean }> = [];
  for (const m of session.messages) {
    if (m.role !== "toolResult") continue;
    const text = typeof m.content === "string"
      ? m.content
      : m.content.map((b) => ("text" in b && typeof b.text === "string" ? b.text : "")).join("");
    out.push({ text, isError: m.isError });
  }
  return out;
}

function idleKernel(): SpawnKernel {
  return new SpawnKernel({
    ledger: new MemoryLedger(),
    sessionPort: { run: async (): Promise<RunLaunchResult> => ({ status: "done", digest: "d", pointers: [], blockers: [] }) },
  });
}

describe("SpawnKernel sub 在飞册：原语语义", () => {
  it("registerSub/subInFlight/releaseSub：计数推进、撞号响亮抛、出册幂等", () => {
    const kernel = idleKernel();
    expect(kernel.subInFlight()).toBe(0);
    kernel.registerSub("ses_aaaaaaaaaaaaaaaa");
    kernel.registerSub("ses_bbbbbbbbbbbbbbbb");
    expect(kernel.subInFlight()).toBe(2);
    expect(() => kernel.registerSub("ses_aaaaaaaaaaaaaaaa")).toThrow(/already in flight/);
    expect(kernel.releaseSub("ses_aaaaaaaaaaaaaaaa")).toBe(true);
    expect(kernel.releaseSub("ses_aaaaaaaaaaaaaaaa")).toBe(false); // 幂等：已出册
    expect(kernel.releaseSub("ses_unknown000000000")).toBe(false);
    expect(kernel.subInFlight()).toBe(1);
  });

  it("asFanout 视图=同一本账（读写穿透内核，非快照拷贝）", () => {
    const kernel = idleKernel();
    const pool = kernel.asFanout();
    pool.register("ses_cccccccccccccccc");
    expect(kernel.subInFlight()).toBe(1);
    expect(pool.count()).toBe(1);
    kernel.releaseSub("ses_cccccccccccccccc");
    expect(pool.count()).toBe(0);
  });

  it("spawn(sub policy) 构建即入册；run 账本分册零触碰（listRuns/ledger 干净）", async () => {
    const ledger = new MemoryLedger();
    const kernel = new SpawnKernel({
      ledger,
      sessionPort: { run: async (): Promise<RunLaunchResult> => ({ status: "done", digest: "d", pointers: [], blockers: [] }) },
    });
    const session = kernel.spawn(
      { kind: "sub", agentType: "general", task: "t", parentSessionId: "ses_parent0000000001", depth: 0 },
      { model: createFakeModel([{ content: [{ type: "text", text: "ok" }] }]), sessionId: "ses_spawnsub0000001", systemPrompt: "", tools: [] },
    );
    expect(kernel.subInFlight()).toBe(1);
    expect(kernel.listRuns()).toHaveLength(0);
    expect(ledger.entries).toHaveLength(0);
    expect(kernel.releaseSub(session.id)).toBe(true);
    expect(kernel.subInFlight()).toBe(0);
  });
});

describe("task 门面委托内核在飞册：跨门面同池封顶（验收 a）", () => {
  it("maxFanout=1：主会话派子在飞时副会话同工具实例再派 → fail-loud（全局数可见）+ 终态归零可复用", async () => {
    const kernel = idleKernel();
    // 脚本队列按调用序消耗：主 turn1(task) → 子回复(慢 120ms，占住在飞窗) →
    // 副 turn1(task → 应被池拒) → 副 turn2(收尾文本) → 主 turn2(收尾文本)。
    const model = createFakeModel([
      { content: [{ type: "toolCall", id: "f-main", name: "task", arguments: { agent_type: "general", task: "M" } }] },
      { content: [{ type: "text", text: "M-子结论" }], delayMs: 120 },
      { content: [{ type: "toolCall", id: "f-side", name: "task", arguments: { agent_type: "general", task: "S" } }] },
      { content: [{ type: "text", text: "side-wrap" }] },
      { content: [{ type: "text", text: "main-wrap" }] },
    ]);
    const handle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model,
      limits: { maxFanout: 1, maxDepth: 2 },
      fanout: kernel.asFanout(),
    });
    // 两个独立主循环体（= 主/副两个门面）共享同一 task 工具实例与同一内核池。
    const mainSim = new AgentSession({ model, tools: [handle.tool], store: new MemorySessionStore() });
    const sideSim = new AgentSession({ model, tools: [handle.tool], store: new MemorySessionStore() });

    const mainRun = mainSim.run("派发一");
    await waitFor(() => kernel.subInFlight() === 1); // 子 M 已构建入册（在飞窗）

    const sideSummary = await sideSim.run("派发二"); // 副 turn1 被池拒 → turn2 自然收尾
    const rejected = toolResults(sideSim).filter((t) => t.isError && t.text.includes("fan-out limit"));
    expect(rejected, "第二来源必须 fail-loud 且文案逐字").toHaveLength(1);
    expect(rejected[0]!.text).toContain("maxFanout=1");
    expect(rejected[0]!.text, "拒绝瞬间全局池数（跨门面可见，非本地计数）").toContain("(1 in flight)");

    await mainRun;
    expect(kernel.subInFlight(), "子 run 终态出册归零").toBe(0);

    // 热载放宽后复用同一池可再派（maxFanout 现读口径不变）。
    handle.limits.maxFanout = 2;
    model.push(
      { content: [{ type: "toolCall", id: "f-reuse", name: "task", arguments: { agent_type: "general", task: "R" } }] },
      { content: [{ type: "text", text: "R-子结论" }] },
      { content: [{ type: "text", text: "final" }] },
    );
    await sideSim.run("派发三");
    expect(kernel.subInFlight()).toBe(0);
    expect(sideSummary.reason).toBe("done");
  }, 20_000);

  it("旧局部计数面回归：不传 fanout 时同 turn 双派发仍第二个被拒（24 测同型语义逐字节）", async () => {
    const model = createFakeModel([
      {
        content: [
          { type: "toolCall", id: "l-a", name: "task", arguments: { agent_type: "general", task: "A" } },
          { type: "toolCall", id: "l-b", name: "task", arguments: { agent_type: "explore", task: "B" } },
        ],
      },
      { content: [{ type: "text", text: "a-done" }] },
      { content: [{ type: "text", text: "wrap" }] },
    ]);
    const handle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model,
      limits: { maxFanout: 1, maxDepth: 2 },
    });
    const parent = new AgentSession({ model, tools: [handle.tool], store: new MemorySessionStore() });
    await parent.run("go");
    const trs = toolResults(parent);
    expect(trs.filter((t) => t.isError && t.text.includes("fan-out limit"))).toHaveLength(1);
  }, 20_000);
});
