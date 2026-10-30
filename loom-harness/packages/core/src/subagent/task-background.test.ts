/**
 * W9 切片 3 —— task 门面 background 分支验收。
 * Given: createTaskTool 注 fanout+subBackground（真 SpawnKernel+MemoryLedger），
 *        父 AgentSession fake 脚本驱动 task(background=true/false)
 * When:  后台派发即返 / 未接线拒绝 / 总量闸封顶 / 同步面回归（background 键缺省）
 * Then:  即返证据=父 turn2 发起时子仍在册（subActiveCount=1）+ toolResult 状态块
 *        形状（task_id/status: running/mode: background + metadata 五键同形 additive）；
 *        出池点=账本终态（onTerminalLocal）→ 子完成后计数归零；
 *        旧局部面（不接线）background:true 响亮拒绝、同步行为零扰动。
 */

import { describe, expect, it } from "vitest";
import { AgentSession, MemorySessionStore } from "../index.js";
import { createFakeModel } from "../testing.js";
import { builtinAgentTypes } from "./agents.js";
import { createTaskTool } from "./task-tool.js";
import { SpawnKernel } from "../kernel/kernel.js";
import { MemoryLedger } from "../run-engine/memory-ledger.js";
import type { RunLaunchResult, RunSessionPort } from "../run-engine/types.js";

const idleKernel = (): SpawnKernel =>
  new SpawnKernel({
    ledger: new MemoryLedger(),
    sessionPort: { run: async (): Promise<RunLaunchResult> => ({ status: "done", digest: "d", pointers: [], blockers: [] }) } satisfies RunSessionPort,
  });

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("waitFor: budget exhausted");
    await new Promise((r) => setTimeout(r, 5));
  }
}

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

describe("task background：派发即返 + 状态块 + 出池终态", () => {
  it("background=true：toolResult 即返状态块；父收尾轮发起时子仍在飞（不 await 实锤）；终态后池归零", async () => {
    const kernel = idleKernel();
    // 消费序：#0 父 turn1（后台派发）→ 子调用随即发起（#1，delay 慢完）→ #2 父 turn2。
    const model = createFakeModel([
      { content: [{ type: "toolCall", id: "bg-1", name: "task", arguments: { agent_type: "general", task: "慢活", background: true } }] },
      { content: [{ type: "text", text: "子后完成" }], delayMs: 150 },
      { content: [{ type: "text", text: "父先收尾" }] },
    ]);
    const handle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model,
      fanout: kernel.asFanout(),
      subBackground: kernel,
    });
    const parent = new AgentSession({ model, tools: [handle.tool], store: new MemorySessionStore() });
    await parent.run("go");

    const trs = toolResults(parent);
    expect(trs).toHaveLength(1);
    expect(trs[0]!.isError).toBe(false);
    expect(trs[0]!.text).toContain("mode: background");
    expect(trs[0]!.text, "task_id 必须是内核 run_ 形状（三面 join 键）").toMatch(/task_id=run_[0-9a-f]{16}/);
    expect(trs[0]!.text).toContain("status: running");
    expect(trs[0]!.text).toContain("<task_metadata>");
    // 同步面五键前缀同形（additive 安全：既有键逐字，行式解析器可宽容跳过新键）
    expect(trs[0]!.text).toMatch(/agent_type: general\nsession_id: ses_[0-9a-f]{16}\nreason: running\nturns: 0\ndepth: 1\ntask_id: run_/);
    // 「即返」的机制实锤：父会话整轮 done 时子任务仍在飞（父 turn2 消费的是 #1，
    // 子的模型调用 #2 在父收尾之后才发生）
    expect(kernel.subActiveCount(), "父轮收束瞬间子仍占在飞账").toBe(1);
    await waitFor(() => kernel.subActiveCount() === 0);

    const recs = kernel.listSubRuns();
    expect(recs).toHaveLength(1);
    expect(recs[0]!.state).toBe("done");
    expect(recs[0]!.parentSessionId, "归属=派发方会话（提醒路由直投依据）").toBe(parent.id);
  }, 20_000);

  it("出池=账本终态：后台在飞期间同步面第二派发被横闸拒（池跨模式共享）", async () => {
    const kernel = idleKernel();
    // 消费序：#0 父 task(bg) → 子 A 调用随即发起（占坑，#1 delay）→ 父 turn2 同步 task
    // 被横闸拒（拒不耗子调用）→ 父 turn3 收尾。
    const model = createFakeModel([
      { content: [{ type: "toolCall", id: "bg-2", name: "task", arguments: { agent_type: "general", task: "占坑", background: true } }] },
      { content: [{ type: "text", text: "bg-child-done" }], delayMs: 120 },
      { content: [{ type: "toolCall", id: "sync-1", name: "task", arguments: { agent_type: "explore", task: "同步" } }] },
      { content: [{ type: "text", text: "sync-wrap" }] },
    ]);
    const handle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model,
      limits: { maxFanout: 1, maxDepth: 2 },
      fanout: kernel.asFanout(),
      subBackground: kernel,
    });
    const parent = new AgentSession({ model, tools: [handle.tool], store: new MemorySessionStore() });
    await parent.run("go");
    const trs = toolResults(parent);
    const rejected = trs.filter((t) => t.isError && t.text.includes("fan-out limit"));
    expect(rejected, "后台占坑期间同步派发 fail-loud（跨模式一池）").toHaveLength(1);
    expect(rejected[0]!.text).toContain("(1 in flight)");
    // bg 子（delay 120）晚于父收尾完成：出池以账本终态为准，非父会话 done 时刻。
    await waitFor(() => kernel.subActiveCount() === 0);
  }, 20_000);

  it("总量闸 maxInflightTotal：后台在册到顶 → fail-loud（继承文案风格），不排队", async () => {
    const kernel = idleKernel();
    // 消费序：#0 父 bg-A → 子 A 调用（#1，delay 100 占账）→ #2 父 bg-B（总量闸拒，不耗子调用）→ #3 父收尾。
    const model = createFakeModel([
      { content: [{ type: "toolCall", id: "t1", name: "task", arguments: { agent_type: "general", task: "A", background: true } }] },
      { content: [{ type: "text", text: "child-a" }], delayMs: 100 },
      { content: [{ type: "toolCall", id: "t2", name: "task", arguments: { agent_type: "general", task: "B", background: true } }] },
      { content: [{ type: "text", text: "wrap" }] },
    ]);
    const handle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model,
      limits: { maxFanout: 8, maxDepth: 2, maxInflightTotal: 1 },
      fanout: kernel.asFanout(),
      subBackground: kernel,
    });
    const parent = new AgentSession({ model, tools: [handle.tool], store: new MemorySessionStore() });
    await parent.run("go");
    const rejected = toolResults(parent).filter((t) => t.isError && t.text.includes("inflight-total limit"));
    expect(rejected, "第二个后台派发被总量闸拒").toHaveLength(1);
    expect(rejected[0]!.text).toContain("maxInflightTotal=1");
    expect(rejected[0]!.text).toContain("(1 in flight)");
    await waitFor(() => kernel.subActiveCount() === 0);
  }, 20_000);

  it("未接线（无内核口）：background:true 响亮拒绝；不传 background 的同步行为零扰动", async () => {    const model = createFakeModel([
      { content: [{ type: "toolCall", id: "nw-1", name: "task", arguments: { agent_type: "general", task: "后台?", background: true } }] },
      { content: [{ type: "text", text: "after-reject" }] },
    ]);
    const handle = await createTaskTool({ agentTypes: builtinAgentTypes(), model });
    const parent = new AgentSession({ model, tools: [handle.tool], store: new MemorySessionStore() });
    await parent.run("go");
    const trs = toolResults(parent);
    expect(trs.filter((t) => t.isError && t.text.includes("background mode requires"))).toHaveLength(1);
  }, 20_000);

  it("deadline 热载（backgroundDeadlineMs 注入 40ms）：挂起后台子被内核定时器收口=failed+cancelRequested=deadline", async () => {
    const kernel = idleKernel();
    const model = createFakeModel([
      { content: [{ type: "toolCall", id: "dl-1", name: "task", arguments: { agent_type: "general", task: "永不回", background: true } }] },
      // 子调用长挂（800ms）：deadline 40ms 到点 → 内核 abort signal → session 当轮 aborted
      // （协作式收尾=正常终局路径非崩溃缺口，W6 cancel 用例同款中止语义）→ 门面整形 failed。
      { content: [{ type: "text", text: "永远到不了的回复" }], delayMs: 800 },
      { content: [{ type: "text", text: "parent-wrap" }] },
    ]);
    const handle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model,
      limits: { maxFanout: 8, maxDepth: 2, backgroundDeadlineMs: 40 },
      fanout: kernel.asFanout(),
      subBackground: kernel,
    });
    const parent = new AgentSession({ model, tools: [handle.tool], store: new MemorySessionStore() });
    await parent.run("go");
    const rec = kernel.listSubRuns()[0];
    expect(rec).toBeDefined();
    await waitFor(() => rec !== undefined && (kernel.getSub(rec.taskId)?.state ?? "running") !== "running");
    const final = kernel.getSub(rec!.taskId)!;
    expect(final.state).toBe("failed");
    expect(final.cancelRequested).toBe("deadline");
    expect(final.crashed, "合法终态非缺口").toBe(false);
    expect(kernel.subActiveCount()).toBe(0);
  }, 20_000);
});
