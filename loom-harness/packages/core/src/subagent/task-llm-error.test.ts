/**
 * W42a — task 派发面的猝死形状复现与修复验收。
 *
 * 事故实证（2026-10-15 数据检查班，trace 2026-10-15.jsonl + 转录 terminal 条目）：
 * data_checker 子会话死于 provider "terminated"（error 流事件终态）。内核 #53 已如实
 * reason="error"（terminal entry 为证），但**消费层整形丢文本**：同步回灌 subAgentResult
 * 对零正文 error assistant 只落 "(sub-agent produced no text output)" 兜底语（trace
 * failure.reason 即此串、summaryLen=35），provider 详情对父模型/trace/账本全部不可见；
 * 且无重试自愈（第三单靠硬约束压上下文才活下来）。
 *
 * 本文件红测先行复现两条猝死形状：
 *   - 同步 task：error-stop → 父 toolResult 只剩兜底语（修复前必红）；
 *   - 后台 task：无本地信号的异常 aborted-stop → 旧内核判 done → 账本 done+兜底语
 *     （缝隙①的派发面投影；修复后诚实 failed+provider 文本）。
 */

import { describe, expect, it } from "vitest";
import type { RunSummary } from "../session.js";
import { AgentSession, MemorySessionStore } from "../index.js";
import { createFakeModel } from "../testing.js";
import { builtinAgentTypes } from "./agents.js";
import { newSubagentSessionId } from "./ids.js";
import { createTaskTool, type TaskEndEvent } from "./task-tool.js";
import { SpawnKernel } from "../kernel/kernel.js";
import { MemoryLedger } from "../run-engine/memory-ledger.js";
import { subAgentResult } from "../plugins/controllers/sub-agent-tool.js";
import type { RunLaunchResult, RunSessionPort } from "../run-engine/types.js";

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

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("waitFor: budget exhausted");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const idleKernel = (): SpawnKernel =>
  new SpawnKernel({
    ledger: new MemoryLedger(),
    sessionPort: {
      run: async (): Promise<RunLaunchResult> => ({ status: "done", digest: "d", pointers: [], blockers: [] }),
    } satisfies RunSessionPort,
  });

describe("W42a task 派发面 — provider 错误文本可达性", () => {
  it("同步 task：子会话 error-stop（'terminated'）猝死 → 父 toolResult 携真实 provider 错误文本【红测：修复前只剩 '(sub-agent produced no text output)'】", async () => {
    const childFake = createFakeModel([
      { content: [], throwError: new Error("terminated") },
    ]);
    const parentFake = createFakeModel([
      { content: [{ type: "toolCall", id: "tc-1", name: "task", arguments: { agent_type: "general", task: "查数据" } }] },
      { content: [{ type: "text", text: "父收尾" }] },
    ]);
    const ends: TaskEndEvent[] = [];
    const handle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      childSessionFactory: () =>
        new AgentSession({
          model: childFake,
          tools: [],
          sessionId: newSubagentSessionId(),
          llmErrorRetries: 0,
          consoleSink: () => {},
        }),
      onSubagentEnd: (e) => {
        ends.push(e);
      },
    });
    const parent = new AgentSession({ model: parentFake, tools: [handle.tool], consoleSink: () => {} });
    await parent.run("go");

    const trs = toolResults(parent);
    expect(trs).toHaveLength(1);
    // 事故形状=兜底语独占文本；修复后 provider 原文必须在场（父模型据此可决定重派）。
    expect(trs[0]!.text).toContain("terminated");
    expect(trs[0]!.text).toContain("[sub-agent LLM error]");
    expect(trs[0]!.text).toContain("reason: error"); // task_metadata 终态词表逐字节在位
    // trace failure.reason 之源（TaskEndEvent.summaryText）同样必须携 provider 文本。
    expect(ends).toHaveLength(1);
    expect(ends[0]!.reason).toBe("error");
    expect(ends[0]!.summaryText ?? "").toContain("terminated");
    childFake.teardown();
    parentFake.teardown();
  });

  it("后台 task：子会话无本地信号异常 aborted-stop（'socket hang up'）→ 账本如实 state=failed，digest/blockers 携 provider 错误文本【红测：修复前缝隙①判 done → done+兜底语】", async () => {
    const kernel = idleKernel();
    const childFake = createFakeModel([
      { content: [], stopReason: "aborted", errorMessage: "socket hang up" },
    ]);
    const parentFake = createFakeModel([
      { content: [{ type: "toolCall", id: "bg-1", name: "task", arguments: { agent_type: "general", task: "后台查数", background: true } }] },
      { content: [{ type: "text", text: "父先收尾" }] },
    ]);
    const handle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      childSessionFactory: () =>
        new AgentSession({
          model: childFake,
          tools: [],
          sessionId: newSubagentSessionId(),
          llmErrorRetries: 0,
          consoleSink: () => {},
        }),
      fanout: kernel.asFanout(),
      subBackground: kernel,
    });
    const parent = new AgentSession({ model: parentFake, tools: [handle.tool], store: new MemorySessionStore(), consoleSink: () => {} });
    await parent.run("go");
    await waitFor(() => kernel.subActiveCount() === 0);

    const recs = kernel.listSubRuns();
    expect(recs).toHaveLength(1);
    const rec = recs[0]!;
    expect(rec.state).toBe("failed"); // 修复前此形状被内核判 done（缝隙①）→ 账本伪装成功
    expect(rec.terminal).not.toBeNull();
    expect(rec.terminal!.digest).toContain("socket hang up");
    expect(rec.terminal!.digest).not.toBe("(sub-agent produced no text output)");
    expect(rec.terminal!.blockers).toContain("termination:error");
    expect(rec.terminal!.blockers.some((b) => b.includes("socket hang up"))).toBe(true);
    childFake.teardown();
    parentFake.teardown();
  });

  it("子会话 provider 持续瞬时失败 → 内核重试自愈后 task 回灌成功正文（重试不消耗子回合数）", async () => {
    const kernel = idleKernel();
    const childFake = createFakeModel([
      { content: [], throwError: new Error("503 unavailable"), advanceOnRetry: true },
      { content: [{ type: "text", text: "重试后的正文交付" }] },
    ]);
    const parentFake = createFakeModel([
      { content: [{ type: "toolCall", id: "tc-2", name: "task", arguments: { agent_type: "general", task: "带病坚持" } }] },
      { content: [{ type: "text", text: "父收尾" }] },
    ]);
    const handle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      childSessionFactory: () =>
        new AgentSession({
          model: childFake,
          tools: [],
          sessionId: newSubagentSessionId(),
          llmErrorRetryBackoffMs: 5,
          consoleSink: () => {},
        }),
      fanout: kernel.asFanout(),
      subBackground: kernel,
    });
    const parent = new AgentSession({ model: parentFake, tools: [handle.tool], consoleSink: () => {} });
    await parent.run("go");

    const trs = toolResults(parent);
    expect(trs[0]!.text).toContain("重试后的正文交付"); // 子会话未猝死：第 2 次发送拿到正文
    expect(trs[0]!.text).toContain("reason: done");
    expect(childFake.getCalls()).toHaveLength(2); // 首发 + 1 次重发
    expect(childFake.getCalls()[0]).toBe(childFake.getCalls()[1]); // 同一已装配请求逐字节复用
    childFake.teardown();
    parentFake.teardown();
  });
});

describe("W42a subAgentResult — 兜底语形状单元钉", () => {
  /** 最小 RunSummary 装配（usage 零值同内核缺省）。 */
  const zeroUsage: RunSummary["usage"] = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  it("reason='error' 且正文为空 → '[sub-agent LLM error] <provider 文本>'；reason='done' 空正文兜底语逐字不动", async () => {
    const fake = createFakeModel([]);
    const sub = new AgentSession({ model: fake, tools: [], sessionId: "unit-sub" });
    const errAssistant = {
      role: "assistant" as const,
      content: [],
      api: "unit", provider: "unit", model: "unit",
      usage: zeroUsage,
      stopReason: "error" as const,
      errorMessage: "terminated",
      timestamp: 1,
    };
    const r1 = subAgentResult(sub, {
      turns: 1, continuations: 0, reason: "error", usage: zeroUsage,
      error: new Error("terminated"),
      lastMessage: errAssistant,
      stopReason: "error",
    });
    const text1 = (r1.content[0] as { text: string }).text;
    expect(text1).toBe("[sub-agent LLM error] terminated");
    expect(r1.details).toBeDefined(); // details.subAgent 结构化终态形状不动
    const r2 = subAgentResult(sub, {
      turns: 1, continuations: 0, reason: "done", usage: zeroUsage,
    });
    expect((r2.content[0] as { text: string }).text).toBe("(sub-agent produced no text output)"); // 旧兜底语逐字
    fake.teardown();
  });

  it("reason='error' 但 lastMessage 携旧正文（陈旧文本警告场景）→ 正文之后追加错误注记，不冒充成功也不丢正文", async () => {
    const fake = createFakeModel([]);
    const sub = new AgentSession({ model: fake, tools: [], sessionId: "unit-sub2" });
    const stale = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "上一轮正文" }],
      api: "unit", provider: "unit", model: "unit",
      usage: zeroUsage,
      stopReason: "stop" as const,
      timestamp: 1,
    };
    const r = subAgentResult(sub, {
      turns: 2, continuations: 0, reason: "error", usage: zeroUsage,
      error: new Error("401 Unauthorized: invalid api key"),
      lastMessage: stale,
      stopReason: "stop",
    });
    const text = (r.content[0] as { text: string }).text;
    expect(text.startsWith("上一轮正文")).toBe(true);
    expect(text).toContain("[sub-agent LLM error] 401 Unauthorized: invalid api key");
    fake.teardown();
  });
});
