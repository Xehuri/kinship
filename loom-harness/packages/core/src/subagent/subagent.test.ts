/**
 * T11 验收测试（docs/02「### T11」Acceptance Criteria）：
 *   a. 结果回灌主会话 messages（子终态以 toolResult 消息形态进父 session，含子正文）；
 *   b. 横向（maxFanout 在飞并发）/ 纵向（maxDepth）上限强制——fail-loud 拒绝，不排队；
 *   c. 输出含字面 `<task_metadata>…session_id: ses_<hex16>…</task_metadata>`（无连字符 id）；
 *   d. agents.ts 装配（fixture-workspace/agents/*.md + 内置 general/explore 存在）。
 *
 * 并发/深度语义走真实父 AgentSession + kernel safe 段 Promise.all（并发真实来源），
 * 子模型用 createFakeModel（../testing.js），零真实 provider。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AgentSession, Type, type HarnessTool, type ToolExecResult } from "../index.js";
import { createFakeModel, createTestContext } from "../testing.js";
import { builtinAgentTypes, loadAgentTypes } from "./agents.js";
import { SUBAGENT_ID_RE, newSubagentSessionId } from "./ids.js";
import {
  extractSubAgentResultInfo,
  parseTaskMetadata,
  renderTaskMetadata,
} from "./metadata.js";
import { createTaskTool } from "./task-tool.js";
import type { TaskEndEvent, TaskStartEvent, TaskToolHandle } from "./task-tool.js";

/** 仓库 fixture 工作区的 agents 目录（同 mcp/tools 测试惯例：import.meta.url 定位，不依赖 cwd）。 */
const FIXTURE_AGENTS_DIR = fileURLToPath(
  new URL("../../../../fixture-workspace/agents", import.meta.url),
);

/** ToolExecResult / toolResult message 共用的块数组 → 纯文本。 */
function resultPlainText(content: readonly unknown[]): string {
  return content
    .map((b) =>
      typeof b === "object" && b !== null && "text" in b && typeof (b as { text: unknown }).text === "string"
        ? (b as { text: string }).text
        : "",
    )
    .join("");
}

/** 取 session messages 里全部 toolResult 的可观测面（文本 + isError）。 */
function toolResults(session: AgentSession): Array<{ text: string; isError: boolean }> {
  const out: Array<{ text: string; isError: boolean }> = [];
  for (const m of session.messages) {
    if (m.role !== "toolResult") continue;
    out.push({ text: resultPlainText(m.content), isError: m.isError });
  }
  return out;
}

/** 字面元数据块的精确形状（行式 key + 无连字符 id；前端反解契约的测试侧镜像）。 */
const METADATA_BLOCK_RE =
  /<task_metadata>\nagent_type: (\S+)\nsession_id: (ses_[0-9a-f]{16})\nreason: (\S+)\nturns: (\d+)\ndepth: (\d+)\n<\/task_metadata>/;

describe("createTaskTool — 装配期与派发入口闸", () => {
  it("agentTypes 为空 → 装配期即抛（fail-loud）", async () => {
    await expect(createTaskTool({ agentTypes: [] })).rejects.toThrow(/must not be empty/);
  });

  it("无 opts.model 且无 resolveModel → 派发造子时抛（默认工厂路径）", async () => {
    const handle = await createTaskTool({ agentTypes: builtinAgentTypes() });
    const tc = createTestContext();
    await expect(
      handle.tool.execute({ agent_type: "general", task: "x" }, tc.ctx, tc.ctx.signal),
    ).rejects.toThrow(/no model for agent type "general"/);
  });

  it("childSessionFactory 造出含连字符 id → 拒绝（前端契约守卫）", async () => {
    const subFake = createFakeModel([{ content: [{ type: "text", text: "ok" }] }]);
    const handle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      childSessionFactory: () =>
        new AgentSession({ model: subFake, tools: [], sessionId: "dash-y-id-0001" }),
    });
    const tc = createTestContext();
    await expect(
      handle.tool.execute({ agent_type: "general", task: "x" }, tc.ctx, tc.ctx.signal),
    ).rejects.toThrow(/violates/);
  });

  it("Limits 非法值在派发时刻现读校验（热改成非法即拒，改回即刻可派——D26 热载语义）", async () => {
    const subFake = createFakeModel([
      { content: [{ type: "text", text: "after fixup" }] },
    ]);
    const limits = { maxFanout: 8, maxDepth: 2 };
    const handle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model: subFake,
      limits,
    });
    const tc = createTestContext();
    limits.maxFanout = 0; // 非法（<1）→ 入口断言拒
    await expect(
      handle.tool.execute({ agent_type: "general", task: "x" }, tc.ctx, tc.ctx.signal),
    ).rejects.toThrow(/invalid subagent Limits/);
    limits.maxFanout = 8; // 同一实例、注入对象热改回合法 → 立即可派发
    const r = await handle.tool.execute(
      { agent_type: "general", task: "x" },
      tc.ctx,
      tc.ctx.signal,
    );
    expect(METADATA_BLOCK_RE.test(resultPlainText(r.content))).toBe(true);
  });

  it("空 task → 拒绝", async () => {
    const handle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model: createFakeModel([]),
    });
    const tc = createTestContext();
    await expect(
      handle.tool.execute({ agent_type: "general", task: "   " }, tc.ctx, tc.ctx.signal),
    ).rejects.toThrow(/empty task/);
  });
});

describe("task 工具 — 结果回灌主会话 + task_metadata 契约（走真实父 loop）", () => {
  it("子正文与 <task_metadata> 以 toolResult 形态进父 messages；Start/End 直接回调配对", async () => {
    const subFake = createFakeModel([
      { content: [{ type: "text", text: "child answer" }], usage: { input: 5, output: 7 } },
    ]);
    const starts: TaskStartEvent[] = [];
    const ends: TaskEndEvent[] = [];
    const handle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model: subFake,
      onSubagentStart: (e) => {
        starts.push(e);
      },
      onSubagentEnd: (e) => {
        ends.push(e);
      },
    });
    const parentFake = createFakeModel([
      {
        content: [
          {
            type: "toolCall",
            name: "task",
            arguments: { agent_type: "general", task: "do the thing" },
          },
        ],
      },
      { content: [{ type: "text", text: "parent wrap" }] },
    ]);
    const parent = new AgentSession({ model: parentFake, tools: [handle.tool] });
    const summary = await parent.run("go");
    expect(summary.reason).toBe("done");

    const trs = toolResults(parent);
    expect(trs).toHaveLength(1);
    expect(trs[0]!.isError).toBe(false);
    // 回灌 = 子正文 + 字面元数据块同在这条 toolResult 文本里（工具结果消息形态，非 system 注入）。
    expect(trs[0]!.text).toContain("child answer");
    const m = METADATA_BLOCK_RE.exec(trs[0]!.text);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("general");
    expect(SUBAGENT_ID_RE.test(m![2]!)).toBe(true); // session_id 无连字符（D31/id 契约）
    expect(m![2]!.includes("-")).toBe(false);
    expect(m![3]).toBe("done");
    expect(m![4]).toBe("1"); // 子 1 turn
    expect(m![5]).toBe("1"); // 父(0) → 子(1)

    // parseTaskMetadata（typed 反解）与逐行正则同通路互证。
    const parsed = parseTaskMetadata(trs[0]!.text);
    expect(parsed).not.toBeNull();
    expect(parsed!.agentType).toBe("general");
    expect(parsed!.sessionId).toBe(m![2]);
    expect(parsed!.reason).toBe("done");
    expect(parsed!.turns).toBe(1);
    expect(parsed!.depth).toBe(1);

    // 直接回调通路（T21 Tracer 接线点）：start↔end 配对、task 文本透传、usage 到手。
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(starts[0]!.agentId).toBe(m![2]);
    expect(starts[0]!.agentType).toBe("general");
    expect(starts[0]!.task).toBe("do the thing");
    expect(starts[0]!.depth).toBe(1);
    expect(ends[0]!.agentId).toBe(m![2]);
    expect(ends[0]!.task).toBe("do the thing");
    expect(ends[0]!.reason).toBe("done");
    expect(ends[0]!.turns).toBe(1);
    expect(ends[0]!.usage?.input).toBe(5);
    expect(ends[0]!.usage?.output).toBe(7);
    expect(ends[0]!.summaryText).toBe("child answer");
  });
});

describe("task 工具 — 横向闸 maxFanout（kernel safe 段并行扇出，事件时刻现读）", () => {
  it("同一 assistant message 两个 task 调用：maxFanout=1 → 第二个被拒（isError 回灌），不静默排队", async () => {
    const subFake = createFakeModel([
      { content: [{ type: "text", text: "only one allowed" }], delayMs: 30 },
    ]);
    const limits = { maxFanout: 1, maxDepth: 2 };
    const handle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model: subFake,
      limits,
    });
    const parentFake = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "task", arguments: { agent_type: "general", task: "A" } },
          { type: "toolCall", name: "task", arguments: { agent_type: "explore", task: "B" } },
        ],
      },
      { content: [{ type: "text", text: "wrap" }] },
    ]);
    const parent = new AgentSession({ model: parentFake, tools: [handle.tool] });
    await parent.run("go");

    const trs = toolResults(parent);
    expect(trs).toHaveLength(2);
    const ok = trs.filter((t) => !t.isError && t.text.includes("<task_metadata>"));
    const rejected = trs.filter((t) => t.isError && t.text.includes("fan-out limit"));
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.text).toContain("maxFanout=1");

    // 闸现读注入对象：热载放宽到 2 后，同一实例下一轮并发全放行（不重建 handle）。
    limits.maxFanout = 2;
    subFake.push(
      { content: [{ type: "text", text: "s1" }] },
      { content: [{ type: "text", text: "s2" }] },
    );
    parentFake.push(
      {
        content: [
          { type: "toolCall", name: "task", arguments: { agent_type: "general", task: "C" } },
          { type: "toolCall", name: "task", arguments: { agent_type: "general", task: "D" } },
        ],
      },
      { content: [{ type: "text", text: "wrap2" }] },
    );
    await parent.run("again");
    const all = toolResults(parent);
    expect(all.filter((t) => t.text.includes("<task_metadata>"))).toHaveLength(3);
    expect(all.filter((t) => t.isError)).toHaveLength(1); // 仍是首轮那一条
  });
});

describe("task 工具 — 纵向闸 maxDepth（深度经 DEPTH_KEY 注入真实子会话）", () => {
  it("maxDepth=1：父 spawn 子成功；子在 depth=1 上再 spawn 被挡（Start 不 fire、不耗 spawn 预算）", async () => {
    const childFake = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "task", arguments: { agent_type: "general", task: "nested" } },
        ],
      },
      { content: [{ type: "text", text: "child final" }] },
    ]);
    // 子会话挂同一 task handle（spawn 时刻 childTools 求值 → 延迟绑定自身）。
    let selfHandle: TaskToolHandle | undefined;
    const starts: TaskStartEvent[] = [];
    const handle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model: childFake,
      limits: { maxFanout: 8, maxDepth: 1 },
      childTools: () => (selfHandle ? [selfHandle.tool] : []),
      onSubagentStart: (e) => {
        starts.push(e);
      },
    });
    selfHandle = handle;

    const parentFake = createFakeModel([
      {
        content: [
          { type: "toolCall", name: "task", arguments: { agent_type: "general", task: "top" } },
        ],
      },
      { content: [{ type: "text", text: "parent done" }] },
    ]);
    const parent = new AgentSession({ model: parentFake, tools: [handle.tool] });
    await parent.run("go");

    // 只 spawn 了一层（子）：嵌套尝试被深度闸挡在 sessionFactory 之前 → start 恰 1 次。
    expect(starts).toHaveLength(1);
    // 子模型第二次的上下文里，必有深度闸的 isError toolResult（拒绝回灌给子模型自己判读）。
    const secondCall = childFake.getCalls()[1];
    expect(secondCall).toBeDefined();
    const depthErr = secondCall!.messages.filter(
      (x) => x.role === "toolResult" && resultPlainText(x.content).includes("depth limit"),
    );
    expect(depthErr).toHaveLength(1);
    // 父侧收口元数据：子 2 turn（1 嵌套尝试 + 1 收尾）、depth=1、done。
    const mm = METADATA_BLOCK_RE.exec(toolResults(parent)[0]!.text);
    expect(mm).not.toBeNull();
    expect(mm![3]).toBe("done");
    expect(mm![4]).toBe("2");
    expect(mm![5]).toBe("1");
  });

  it("直接 execute：ctx.state 深度已达 maxDepth → 拒绝（子模型零请求）", async () => {
    const subFake = createFakeModel([{ content: [{ type: "text", text: "never" }] }]);
    const handle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model: subFake,
      limits: { maxFanout: 8, maxDepth: 2 },
    });
    const tc = createTestContext();
    tc.ctx.state.set("subAgent.depth", 2);
    await expect(
      handle.tool.execute({ agent_type: "general", task: "x" }, tc.ctx, tc.ctx.signal),
    ).rejects.toThrow(/depth limit \(maxDepth=2\) reached/);
    expect(subFake.getCalls()).toHaveLength(0); // 挡在 spawn 之前，不耗子模型响应
  });

  it("maxDepth=2：孙可 spawn；子层 toolResult 也带 depth:2 元数据（深度透传 + 整形在两代贯通）", async () => {
    const gcFake = createFakeModel([{ content: [{ type: "text", text: "grandchild answer" }] }]);
    const childFake = createFakeModel([
      {
        content: [
          {
            type: "toolCall",
            name: "task",
            arguments: { agent_type: "general", task: "to-grandchild" },
          },
        ],
      },
      { content: [{ type: "text", text: "child relays" }] },
    ]);
    // 父 handle 造子（model=childFake）；子会话的工具是孙 handle（model=gcFake）。
    const grandHandle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model: gcFake,
      limits: { maxFanout: 8, maxDepth: 2 },
    });
    const parentHandle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model: childFake,
      limits: { maxFanout: 8, maxDepth: 2 },
      childTools: () => [grandHandle.tool],
    });
    const parentFake = createFakeModel([
      {
        content: [
          {
            type: "toolCall",
            name: "task",
            arguments: { agent_type: "general", task: "two levels" },
          },
        ],
      },
      { content: [{ type: "text", text: "parent wraps" }] },
    ]);
    const parent = new AgentSession({ model: parentFake, tools: [parentHandle.tool] });
    await parent.run("go");

    // 孙真的跑了（gcFake 收到 1 次请求）。
    expect(gcFake.getCalls()).toHaveLength(1);
    // 子模型第二次上下文：孙结果以 toolResult 回灌子会话，且元数据 depth=2。
    const secondCall = childFake.getCalls()[1];
    expect(secondCall).toBeDefined();
    const childTrText = secondCall!.messages
      .filter((x) => x.role === "toolResult")
      .map((x) => (x.role === "toolResult" ? resultPlainText(x.content) : ""))
      .join("\n");
    const m2 = METADATA_BLOCK_RE.exec(childTrText);
    expect(m2).not.toBeNull();
    expect(m2![5]).toBe("2"); // 孙 depth=2
    expect(childTrText).toContain("grandchild answer");
    // 父层收口：子 2 turn、depth=1。
    const mm = METADATA_BLOCK_RE.exec(toolResults(parent)[0]!.text);
    expect(mm![4]).toBe("2");
    expect(mm![5]).toBe("1");
  });

  it("W6 三代真链（maxDepth=2）：孙（DEPTH_KEY 注入后 depth=2）再派被挡在 spawn 前——曾祖模型零请求、Start 不 fire、depth-limit 以 isError 回灌孙", async () => {
    // 孙的脚本：turn1 尝试再派（应被纵向闸挡）；turn2 拿到 isError 后文本收尾。
    const gcFake = createFakeModel([
      {
        content: [
          {
            type: "toolCall",
            name: "task",
            arguments: { agent_type: "general", task: "too-deep" },
          },
        ],
      },
      { content: [{ type: "text", text: "gc wraps after block" }] },
    ]);
    // 被挡即不得触达曾祖层：greatHandle 的模型/工厂在任何路径都不该被调用。
    const greatFake = createFakeModel([{ content: [{ type: "text", text: "never runs" }] }]);
    const greatStarts: TaskStartEvent[] = [];
    const greatHandle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model: greatFake,
      limits: { maxFanout: 8, maxDepth: 2 },
      onSubagentStart: (e) => { greatStarts.push(e); },
    });
    const grandStarts: TaskStartEvent[] = [];
    const grandHandle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model: gcFake,
      limits: { maxFanout: 8, maxDepth: 2 },
      childTools: () => [greatHandle.tool],
      onSubagentStart: (e) => { grandStarts.push(e); },
    });
    const childFake = createFakeModel([
      {
        content: [
          {
            type: "toolCall",
            name: "task",
            arguments: { agent_type: "general", task: "to-grandchild" },
          },
        ],
      },
      { content: [{ type: "text", text: "child relays gc" }] },
    ]);
    const parentStarts: TaskStartEvent[] = [];
    const parentHandle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model: childFake,
      limits: { maxFanout: 8, maxDepth: 2 },
      childTools: () => [grandHandle.tool],
      onSubagentStart: (e) => { parentStarts.push(e); },
    });
    const parentFake = createFakeModel([
      {
        content: [
          {
            type: "toolCall",
            name: "task",
            arguments: { agent_type: "general", task: "three levels" },
          },
        ],
      },
      { content: [{ type: "text", text: "parent wraps" }] },
    ]);
    const parent = new AgentSession({ model: parentFake, tools: [parentHandle.tool] });
    await parent.run("go");

    // 纵向闸挡在 spawn 之前：曾祖模型零请求、greatHandle 一次 Start 都不 fire（不耗预算）。
    expect(greatFake.getCalls()).toHaveLength(0);
    expect(greatStarts).toHaveLength(0);
    expect(parentStarts).toHaveLength(1);
    expect(grandStarts).toHaveLength(1);
    expect(parentStarts[0]!.depth).toBe(1);
    expect(grandStarts[0]!.depth).toBe(2);

    // 孙的真实上下文：第二次请求必含 depth-limit 的 isError toolResult（拒绝回灌给孙模型判读，
    // 且深度是 DEPTH_KEY 注入所得（2），非合成 ctx.state）。
    const gcSecondCall = gcFake.getCalls()[1];
    expect(gcSecondCall).toBeDefined();
    const gcBlock = gcSecondCall!.messages.filter(
      (x) => x.role === "toolResult" && resultPlainText(x.content).includes("depth limit (maxDepth=2) reached"),
    );
    expect(gcBlock).toHaveLength(1);
    expect((gcBlock[0] as unknown as { isError?: boolean }).isError).toBe(true);

    // 两代贯通不回归：父层收口 depth=1、子层收口 depth=2。
    const mm = METADATA_BLOCK_RE.exec(toolResults(parent)[0]!.text);
    expect(mm![5]).toBe("1");
    const childSecondCall = childFake.getCalls()[1];
    const childTr = childSecondCall!.messages
      .filter((x) => x.role === "toolResult")
      .map((x) => resultPlainText(x.content))
      .join("\n");
    const mm2 = METADATA_BLOCK_RE.exec(childTr);
    expect(mm2).not.toBeNull();
    expect(mm2![5]).toBe("2");
    expect(childTr).toContain("gc wraps after block");
  }, 20_000);
});

describe("task 工具 — registry 留存 / 续聊 / 父 abort 清空", () => {
  it("retain=true（默认）：跑完首轮即留存、可按 id 续聊；retain=false → registry=null", async () => {
    const subFake = createFakeModel([
      { content: [{ type: "text", text: "first" }] },
      { content: [{ type: "text", text: "continued" }] },
    ]);
    const handle = await createTaskTool({ agentTypes: builtinAgentTypes(), model: subFake });
    expect(handle.registry).not.toBeNull();
    const tc = createTestContext();
    const r1 = await handle.tool.execute(
      { agent_type: "explore", task: "t1" },
      tc.ctx,
      tc.ctx.signal,
    );
    const id = parseTaskMetadata(resultPlainText(r1.content))!.sessionId!;
    expect(handle.registry!.size).toBe(1);

    const r2 = await handle.registry!.continueSubAgent(id, "more", { signal: tc.ctx.signal });
    expect(JSON.stringify(r2.details)).toContain(id);
    expect(resultPlainText(r2.content)).toContain("continued");

    const noReg = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model: createFakeModel([]),
      retain: false,
    });
    expect(noReg.registry).toBeNull();
  });

  it("父 signal abort → 留存句柄清空（资源安全，句柄不跨 abort 泄漏）", async () => {
    const subFake = createFakeModel([{ content: [{ type: "text", text: "x" }] }]);
    const handle = await createTaskTool({ agentTypes: builtinAgentTypes(), model: subFake });
    const ac = new AbortController();
    const tc = createTestContext({ signal: ac.signal });
    const r1 = await handle.tool.execute(
      { agent_type: "general", task: "t" },
      tc.ctx,
      ac.signal,
    );
    const id = parseTaskMetadata(resultPlainText(r1.content))!.sessionId!;
    expect(handle.registry!.size).toBe(1);
    ac.abort();
    expect(handle.registry!.size).toBe(0);
    await expect(handle.registry!.continueSubAgent(id, "again")).rejects.toThrow(
      /no retained sub-agent/,
    );
  });
});

describe("task 工具 — D24 父取消 mid-run 传播（子会话协作式中止，不留悬挂子）", () => {
  it("两子同时在飞 → abort 父：两子当轮即以 aborted 终局、元数据回灌 reason=aborted、End 事件配对", async () => {
    // 慢子工具：仅在其 signal abort 时 resolve——子会话确定性地"在飞"（挂在工具里），
    // abort 后 promise 释放 = 子内核下一 turn 入口检 abort → 终局 reason=aborted（不靠时序运气）。
    const hangTool: HarnessTool = {
      name: "hang",
      description: "test-only tool that resolves only when its signal aborts",
      parameters: Type.Object({}),
      execute(_args, _ctx, signal): Promise<ToolExecResult> {
        return new Promise<ToolExecResult>((resolve) => {
          const release = (): void =>
            resolve({ content: [{ type: "text", text: "hang released by abort" }], details: {} });
          if (signal.aborted) release();
          else signal.addEventListener("abort", release, { once: true });
        });
      },
    };
    const subFake = createFakeModel([
      { content: [{ type: "toolCall", name: "hang", arguments: {} }] },
      { content: [{ type: "toolCall", name: "hang", arguments: {} }] },
    ]);
    const ends: TaskEndEvent[] = [];
    const handle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model: subFake,
      childTools: () => [hangTool],
      onSubagentEnd: (e) => {
        ends.push(e);
      },
    });
    const ac = new AbortController();
    const tc = createTestContext({ signal: ac.signal });
    const p1 = handle.tool.execute({ agent_type: "general", task: "t1" }, tc.ctx, ac.signal);
    const p2 = handle.tool.execute({ agent_type: "explore", task: "t2" }, tc.ctx, ac.signal);

    // 两子真进入在飞（各自首个模型请求已发出）。
    const t0 = Date.now();
    while (subFake.getCalls().length < 2 && Date.now() - t0 < 2_000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(subFake.getCalls()).toHaveLength(2);

    ac.abort();
    // 父取消传播的硬证：两个派发都终止返回（若子会话不协作中止，这里永久悬挂 → 测试超时即红）。
    const [r1, r2] = await Promise.all([p1, p2]);
    const meta1 = parseTaskMetadata(resultPlainText(r1.content));
    const meta2 = parseTaskMetadata(resultPlainText(r2.content));
    expect(meta1?.reason).toBe("aborted");
    expect(meta2?.reason).toBe("aborted");
    expect(ends).toHaveLength(2);
    for (const e of ends) {
      expect(e.reason).toBe("aborted");
      expect(SUBAGENT_ID_RE.test(e.agentId)).toBe(true);
    }
    // Start↔End 配对：两子各 1 条 end，agentId 互异（两代并行派发都被取消，无遗漏）。
    expect(new Set(ends.map((e) => e.agentId)).size).toBe(2);
  }, 15_000);
});

describe("agents.ts — 内置 general/explore + fixture-workspace/agents 装配", () => {
  it("builtinAgentTypes：general/explore 内置存在、零 IO", async () => {
    const all = builtinAgentTypes();
    const types = all.map((d) => d.type);
    expect(types).toContain("general");
    expect(types).toContain("explore");
    for (const d of all) {
      expect(d.source).toBe("builtin");
      expect((await d.loadSystemPrompt()).length).toBeGreaterThan(0);
    }
  });

  it("loadAgentTypes(fixture-workspace/agents)：内置存在 + 工作区 .md 被扫入；纯中文 stem degrade", async () => {
    const res = await loadAgentTypes({ dirs: [FIXTURE_AGENTS_DIR] });
    const types = res.entries.map((d) => d.type);
    expect(types).toContain("general"); // 内置不因工作区文件而缺席
    expect(types).toContain("explore");
    // fixture 里 `01-data-check.md` → stem 清洗成 ASCII 路由标识（连字符折叠为下划线）。
    expect(types).toContain("01_data_check");
    const fileEntry = res.entries.find((d) => d.type === "01_data_check");
    expect(fileEntry!.source).toBe("file");
    // 懒读正文：loadSystemPrompt 返回围栏后正文（含数据检查职责段）。
    expect(await fileEntry!.loadSystemPrompt()).toContain("数据检查");
    // `复盘-公共.md`：stem 清洗后为空（纯中文）→ degrade 跳过，绝不入清单。
    expect(types.some((t) => t.includes("复盘") || t.includes("公共"))).toBe(false);
    expect(res.degraded.some((d) => d.file!.endsWith("复盘-公共.md"))).toBe(true);
    // degrade 不拖垮整表：其余文件照常装配。
    expect(res.entries.length).toBeGreaterThan(2);
  });

  it("loadAgentTypes：dirs 为空 → 抛；目录不可读 → 抛（配置错误要响）", async () => {
    await expect(loadAgentTypes({ dirs: [] })).rejects.toThrow(/must not be empty/);
    await expect(loadAgentTypes({ dirs: ["/nonexistent-dir-for-t11"] })).rejects.toThrow(
      /cannot read agents dir/,
    );
  });
});

describe("ids / metadata 原语（前端契约的生成与反解）", () => {
  it("newSubagentSessionId 恒匹配 SUBAGENT_ID_RE 且不含连字符", () => {
    for (let i = 0; i < 50; i += 1) {
      const id = newSubagentSessionId();
      expect(SUBAGENT_ID_RE.test(id)).toBe(true);
      expect(id.includes("-")).toBe(false);
    }
  });

  it("renderTaskMetadata ↔ parseTaskMetadata 往返（字面块行式 key）", () => {
    const sid = newSubagentSessionId();
    const text = renderTaskMetadata({
      agentType: "explore",
      sessionId: sid,
      reason: "max_turns",
      turns: 7,
      depth: 2,
    });
    expect(text).toContain(`<task_metadata>\nagent_type: explore\nsession_id: ${sid}`);
    const back = parseTaskMetadata(text);
    expect(back!.sessionId).toBe(sid);
    expect(back!.agentType).toBe("explore");
    expect(back!.reason).toBe("max_turns");
    expect(back!.turns).toBe(7);
    expect(back!.depth).toBe(2);
  });

  it("parseTaskMetadata：无块 → null；turns 非数字容错（缺该字段），depth 数字保留", () => {
    expect(parseTaskMetadata("no block here")).toBeNull();
    const p = parseTaskMetadata("<task_metadata>\nturns: NaN\ndepth: 3\n</task_metadata>");
    expect(p!.turns).toBeUndefined();
    expect(p!.depth).toBe(3);
  });

  it("extractSubAgentResultInfo：形状不符 → null；usage 非对象 → 字段缺省（exactOptional 口径）", () => {
    expect(extractSubAgentResultInfo("string")).toBeNull();
    expect(extractSubAgentResultInfo({ subAgent: { sessionId: "s", reason: "done" } })).toBeNull();
    const ok = extractSubAgentResultInfo({
      subAgent: { sessionId: "s", reason: "done", turns: 1 },
    });
    expect(ok).not.toBeNull();
    expect(ok!.usage).toBeUndefined();
  });

  it("details 原样透传 + 文本 = 正文与块以空行相接（整形契约）", async () => {
    const subFake = createFakeModel([{ content: [{ type: "text", text: "body" }] }]);
    const handle = await createTaskTool({ agentTypes: builtinAgentTypes(), model: subFake });
    const tc = createTestContext();
    const r: ToolExecResult = await handle.tool.execute(
      { agent_type: "general", task: "t" },
      tc.ctx,
      tc.ctx.signal,
    );
    const details = extractSubAgentResultInfo(r.details);
    expect(details).not.toBeNull();
    expect(details!.sessionId).toMatch(SUBAGENT_ID_RE);
    expect(resultPlainText(r.content)).toContain("body\n\n<task_metadata>");
  });
});

describe("agents.ts frontmatter.memory 自声明暴露（B 面）", () => {
  it("声明了 memory 的条目带 memoryGlobs；未声明的条目缺省 undefined（消费侧缺省=只 AGENTS.md，W8' 收紧语义 1）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-agents-mem-"));
    try {
      const agents = join(dir, "agents");
      mkdirSync(agents, { recursive: true });
      writeFileSync(join(agents, "with-mem.md"), [
        "---",
        "name: with_mem",
        "memory: [memory/fact/**, AGENTS.md]",
        "---",
        "# 带声明的角色",
      ].join("\n"));
      writeFileSync(join(agents, "no-mem.md"), ["---", "tags: [x]", "---", "# 无声明的角色"].join("\n"));
      const res = await loadAgentTypes({ dirs: [agents], includeBuiltins: false });
      const withMem = res.entries.find((d) => d.type === "with_mem");
      const noMem = res.entries.find((d) => d.type === "no_mem");
      expect(withMem?.memoryGlobs).toEqual(["memory/fact/**", "AGENTS.md"]);
      expect(noMem?.memoryGlobs).toBeUndefined();
      expect(await withMem?.loadSystemPrompt()).toContain("带声明的角色");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fixture 现网角色镜像文件（磁盘声明逐字镜像，随 2026-10-14 用户重配现网同步）：可载入角色逐个带声明集，degrade 件不入清单", async () => {
    const res = await loadAgentTypes({ dirs: [FIXTURE_AGENTS_DIR] });
    // 本 expected 是 fixture-workspace/agents/*.md frontmatter 的只读镜像（非规格真源）；
    // 2026-10-14 12:48–12:55 用户在现网树把 01–04 声明改为 11 件人格式、05 改为 [AGENTS.md]。
    // 镜像随盘同步，钉法不变（逐 type 全数组 toEqual，零放宽）——W34 主会话接线与本片无耦合。
    const roster11: readonly string[] = [
      "agents/规则-01-data-check.md",
      "memory/self/必读.md",
      "memory/self/关系.md",
      "memory/self/价值校准.md",
      "memory/self/纠错.md",
      "memory/self/认知.md",
      "memory/self/任务.md",
      "memory/self/身份.md",
      "memory/self/SELF-INDEX.md",
      "memory/profile/core.md",
      "memory/profile/state.md",
    ];
    const expected: Record<string, readonly string[]> = {
      "01_data_check": roster11,
      "02_daily_review": roster11,
      "03_biweekly_review": roster11,
      "04_weekly_review": roster11,
      "05_audit": ["AGENTS.md"],
    };
    for (const [type, globs] of Object.entries(expected)) {
      const def = res.entries.find((d) => d.type === type);
      expect(def?.memoryGlobs, type).toEqual(globs);
    }
    // 规则-01 stem 清洗后与 01_data_check 撞名 → degrade（声明存在但不入清单，与 复盘-公共 同族）。
    expect(res.degraded.some((d) => d.file!.endsWith("规则-01-data-check.md"))).toBe(true);
    expect(res.degraded.some((d) => d.file!.endsWith("复盘-公共.md"))).toBe(true);
  });
});

describe("agents.ts 同步正文加载（spawn 期现读）", () => {
  it("builtin：loadSystemPromptSync 与 loadSystemPrompt 同字节", async () => {
    for (const def of builtinAgentTypes()) {
      expect(def.loadSystemPromptSync()).toBe(await def.loadSystemPrompt());
    }
  });

  it("file：每次调用重读文件，文件改动后返回新正文", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-agents-sync-"));
    try {
      const agents = join(dir, "agents");
      mkdirSync(agents, { recursive: true });
      const file = join(agents, "sync-role.md");
      writeFileSync(file, ["---", "name: sync_role", "---", "# 同步正文 A"].join("\n"));
      const res = await loadAgentTypes({ dirs: [agents], includeBuiltins: false });
      const def = res.entries.find((d) => d.type === "sync_role");
      expect(def).toBeDefined();
      expect(def!.loadSystemPromptSync()).toContain("同步正文 A");

      writeFileSync(file, ["---", "name: sync_role", "---", "# 同步正文 B"].join("\n"));
      expect(def!.loadSystemPromptSync()).toContain("同步正文 B");
      expect(def!.loadSystemPromptSync()).not.toContain("同步正文 A");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("file：文件被删除后回落扫描期正文且不抛", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-agents-sync-gone-"));
    try {
      const agents = join(dir, "agents");
      mkdirSync(agents, { recursive: true });
      const file = join(agents, "gone-role.md");
      writeFileSync(file, ["---", "name: gone_role", "---", "# 删除前正文"].join("\n"));
      const res = await loadAgentTypes({ dirs: [agents], includeBuiltins: false });
      const def = res.entries.find((d) => d.type === "gone_role");
      expect(def).toBeDefined();

      rmSync(file);
      expect(() => def!.loadSystemPromptSync()).not.toThrow();
      expect(def!.loadSystemPromptSync()).toContain("删除前正文");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("agents.ts W17-E kind:main|sub 声明（缺省 sub 向后兼容 / 非法值 fail-soft / 清单序稳定）", () => {
  it("无 kind→sub；kind:MAIN→main（大小写不敏感）；非法值→sub+warn 留痕且条目照常入清单；工作区件按文件名序、内置占头", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-agents-kind-"));
    try {
      const agents = join(dir, "agents");
      mkdirSync(agents, { recursive: true });
      // 文件名序刻意为 b/a/c：验证 entries 序 = 排序扫描序（多 main 取首依赖此序）。
      writeFileSync(join(agents, "b-main.md"), ["---", "name: b_main", "kind: MAIN", "---", "# 主人格声明"].join("\n"));
      writeFileSync(join(agents, "a-plain.md"), ["---", "name: a_plain", "---", "# 无声明角色"].join("\n"));
      writeFileSync(join(agents, "c-junk.md"), ["---", "name: c_junk", "kind: hybrid", "---", "# 非法声明角色"].join("\n"));
      const res = await loadAgentTypes({ dirs: [agents] });
      const kindByType = new Map(res.entries.map((d) => [d.type, d.kind]));
      expect(kindByType.get("a_plain")).toBe("sub"); // 缺省 = sub（旧文件逐字节现状兼容）
      expect(kindByType.get("b_main")).toBe("main"); // 大小写不敏感
      expect(kindByType.get("c_junk")).toBe("sub"); // 非法值 fail-soft：入清单、按 sub、不 throw
      expect(kindByType.get("general")).toBe("sub"); // 内置恒 sub
      expect(kindByType.get("explore")).toBe("sub");
      const fileTypes = res.entries.filter((d) => d.source === "file").map((d) => d.type);
      expect(fileTypes).toEqual(["a_plain", "b_main", "c_junk"]);
      // warn 只记非法值件（缺省/合法值零噪音）；degrade 不受 kind 面影响。
      expect(res.warnings).toHaveLength(1);
      expect(res.warnings[0]!.file).toContain("c-junk.md");
      expect(res.warnings[0]!.reason).toContain("hybrid");
      expect(res.degraded).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fixture 现网角色实况钉（W33 起）：恰一枚 kind:main（main.md，用户 2026-10-12 决策「加 md 文件顶替默认值」自投），其余五角色+内置逐条目缺省 sub，合法值零 warn", async () => {
    const res = await loadAgentTypes({ dirs: [FIXTURE_AGENTS_DIR] });
    // main 唯一性逐条目核（多枚 main = 影子实例人格面被污染，boot 首枚生效语义会被静默改写）。
    const mains = res.entries.filter((d) => d.kind === "main");
    expect(mains.map((d) => d.type)).toEqual(["main"]);
    expect(String(mains[0]?.file ?? "")).toContain("main.md");
    const kindByType = new Map(res.entries.map((d) => [d.type, d.kind]));
    for (const type of ["01_data_check", "02_daily_review", "03_biweekly_review", "04_weekly_review", "05_audit", "general", "explore"]) {
      expect(kindByType.get(type), type).toBe("sub");
    }
    expect(res.warnings).toHaveLength(0);
  });
});

describe("task-tool W17-E 派发面过滤 kind:main（人格声明不可派发）", () => {
  /** 混合目录：persona.md(kind:main) + helper.md(缺省 sub)，内置同批。 */
  async function kindMixedTypes(prefix: string): Promise<{ dir: string; entries: Awaited<ReturnType<typeof loadAgentTypes>>["entries"] }> {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const agents = join(dir, "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "persona.md"), ["---", "name: persona", "kind: main", "---", "# 人格正文"].join("\n"));
    writeFileSync(join(agents, "helper.md"), ["---", "name: helper", "---", "# 帮手正文"].join("\n"));
    const res = await loadAgentTypes({ dirs: [agents] });
    return { dir, entries: res.entries };
  }

  it("main+sub+内置混合：agent_type 枚举含内置/sub、main 零痕迹；强派 main → unknown agent_type 清晰错误（不崩）", async () => {
    const mix = await kindMixedTypes("loom-task-kind-");
    try {
      const handle = await createTaskTool({ agentTypes: mix.entries, model: createFakeModel([]) });
      const paramJson = JSON.stringify(handle.tool.parameters);
      expect(paramJson).toContain('"const":"general"'); // 内置可见
      expect(paramJson).toContain('"const":"explore"');
      expect(paramJson).toContain('"const":"helper"'); // 缺省 sub 可见
      expect(paramJson).not.toContain("persona"); // 枚举与描述枚举都无 main 件痕迹
      const tc = createTestContext();
      // 绕过 schema 强派：路由表（specs 同源过滤）给清晰 unknown 错误 → kernel 包 isError，绝不 500。
      await expect(
        handle.tool.execute({ agent_type: "persona", task: "t" }, tc.ctx, tc.ctx.signal),
      ).rejects.toThrow(/unknown agent_type/);
    } finally {
      rmSync(mix.dir, { recursive: true, force: true });
    }
  });

  it("全 main 的 agentTypes → 装配期抛（无可派发面 = 配置错误，与空表同族 fail-loud）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-task-allmain-"));
    try {
      const agents = join(dir, "agents");
      mkdirSync(agents, { recursive: true });
      writeFileSync(join(agents, "only.md"), ["---", "name: only_main", "kind: main", "---", "# 只有人格"].join("\n"));
      const res = await loadAgentTypes({ dirs: [agents], includeBuiltins: false });
      await expect(createTaskTool({ agentTypes: res.entries })).rejects.toThrow(/no dispatchable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
