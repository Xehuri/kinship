/**
 * W49.2 —— 子会话标题链（task 工具可选 title）门面验收。
 * Given: createTaskTool（前台直调 execute / 后台接 SpawnKernel+MemoryLedger），
 *        fake 模型脚本驱动，零真实 provider。
 * When:  显式 title / 缺省 title / 空串·纯空白 title 三类派发
 * Then:  title 以**同一字符串**流经各载体：
 *        ① 前台 <task_metadata>——显式在场时 title 行插块首（open 标签后、agent_type 前），
 *           缺省时块形状逐字节旧形（既有消费者 METADATA_BLOCK_RE 精确 5 行反解零扰动）；
 *        ② TaskStartEvent——恒携生效标题（显式或 derived，观察面）；
 *        ③ 后台状态块 + 内核在飞册记录 + 账本 expected payload——derived 兜底 =
 *           任务正文折叠空白后前 40 **码点**（截断补 …，Array.from 码点口径非 UTF-16 长度）。
 * 决策注：前台块 derived 不落行是**刻意的**——行式块五键形状是前端反解契约（metadata.ts 头注），
 *       既有消费者按精确 5 行正则解析；title 缺省时保持旧形状字节保真，显式才加行。
 */

import { describe, expect, it } from "vitest";
import { AgentSession, MemorySessionStore } from "../index.js";
import { createFakeModel, createTestContext } from "../testing.js";
import { builtinAgentTypes } from "./agents.js";
import { createTaskTool } from "./task-tool.js";
import type { TaskStartEvent } from "./task-tool.js";
import { SpawnKernel } from "../kernel/kernel.js";
import { MemoryLedger } from "../run-engine/memory-ledger.js";
import type { RunLaunchResult, RunSessionPort } from "../run-engine/types.js";

/** 旧 5 键精确形状（前端反解契约镜像，与 subagent.test.ts 同形）。 */
const LEGACY_5KEY_RE =
  /<task_metadata>\nagent_type: (\S+)\nsession_id: (ses_[0-9a-f]{16})\nreason: (\S+)\nturns: (\d+)\ndepth: (\d+)\n<\/task_metadata>/;

function resultPlainText(content: readonly unknown[]): string {
  return content
    .map((b) =>
      typeof b === "object" && b !== null && "text" in b && typeof (b as { text: unknown }).text === "string"
        ? (b as { text: string }).text
        : "",
    )
    .join("");
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

const idlePort: RunSessionPort = {
  run: async (): Promise<RunLaunchResult> => ({ status: "done", digest: "d", pointers: [], blockers: [] }),
};

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("waitFor: budget exhausted");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 后台派发全装具：真 SpawnKernel + 可控 MemoryLedger 取证。 */
async function bgHarness(titleArg?: string) {
  const ledger = new MemoryLedger();
  const kernel = new SpawnKernel({ ledger, sessionPort: idlePort });
  const model = createFakeModel([
    {
      content: [
        {
          type: "toolCall",
          id: "tt-bg",
          name: "task",
          arguments: {
            agent_type: "general",
            task: "后台取件活",
            background: true,
            ...(titleArg !== undefined ? { title: titleArg } : {}),
          },
        },
      ],
    },
    { content: [{ type: "text", text: "子完成" }] },
    { content: [{ type: "text", text: "父收口" }] },
  ]);
  const handle = await createTaskTool({
    agentTypes: builtinAgentTypes(),
    model,
    fanout: kernel.asFanout(),
    subBackground: kernel,
  });
  const parent = new AgentSession({ model, tools: [handle.tool], store: new MemorySessionStore() });
  return { kernel, ledger, handle, parent };
}

describe("W49.2 task title 链：显式/derived/空串三态 × 前台/后台两路", () => {
  it("显式 title：前台块 title 行插 open 标签后，其余 5 行逐字节旧形；TaskStartEvent 携同一字符串", async () => {
    const subFake = createFakeModel([{ content: [{ type: "text", text: "child ok" }] }]);
    const starts: TaskStartEvent[] = [];
    const handle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model: subFake,
      onSubagentStart: (e) => { starts.push(e); },
    });
    const tc = createTestContext();
    const r = await handle.tool.execute(
      { agent_type: "general", task: "干点活", title: "10-16 夜间 · 折扣审计" },
      tc.ctx,
      tc.ctx.signal,
    );
    const text = resultPlainText(r.content);
    expect(text).toContain("<task_metadata>\ntitle: 10-16 夜间 · 折扣审计\nagent_type: general\nsession_id: ");
    expect(text).toMatch(/\ndepth: 1\n<\/task_metadata>/);
    // title 行之外的主体仍是旧 5 键形状（行式消费者逐行宽容，title 键可跳过）。
    expect(LEGACY_5KEY_RE.test(text.replace("<task_metadata>\ntitle: 10-16 夜间 · 折扣审计\n", "<task_metadata>\n"))).toBe(true);
    expect(starts[0]!.title).toBe("10-16 夜间 · 折扣审计");
  });

  it("缺省 title：前台块逐字节旧 5 键形（不造 title 行）；TaskStartEvent title=任务正文 derived", async () => {
    const subFake = createFakeModel([{ content: [{ type: "text", text: "child ok" }] }]);
    const starts: TaskStartEvent[] = [];
    const handle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model: subFake,
      onSubagentStart: (e) => { starts.push(e); },
    });
    const tc = createTestContext();
    const r = await handle.tool.execute(
      { agent_type: "general", task: "多行\n\n正文   折叠\t制表" },
      tc.ctx,
      tc.ctx.signal,
    );
    const text = resultPlainText(r.content);
    expect(text).not.toContain("title:");
    expect(LEGACY_5KEY_RE.test(text)).toBe(true);
    // derived = 折叠空白后整段（不足 40 码点，无省略号）。
    expect(starts[0]!.title).toBe("多行 正文 折叠 制表");
  });

  it("derived 兜底口径：码点 40 封顶（补充平面一字=1 码点），截断补 …；非 UTF-16 长度口径", async () => {
    const subFake = createFakeModel([{ content: [{ type: "text", text: "ok" }] }]);
    const starts: TaskStartEvent[] = [];
    const handle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model: subFake,
      onSubagentStart: (e) => { starts.push(e); },
    });
    const tc = createTestContext();
    // 50 个代理对字符（UTF-16 长度 100，码点数 50）→ 兜底取前 40 码点 + …。
    await handle.tool.execute({ agent_type: "general", task: "𐏑".repeat(50) }, tc.ctx, tc.ctx.signal);
    const title = starts[0]!.title!;
    expect(Array.from(title)).toHaveLength(41); // 40 码点 + 1 省略号
    expect(title).toBe("𐏑".repeat(40) + "…");
  });

  it("空串/纯空白 title → derived 兜底（前台块仍旧形，事件带 derived）", async () => {
    const subFake = createFakeModel([{ content: [{ type: "text", text: "ok" }] }]);
    const starts: TaskStartEvent[] = [];
    const handle = await createTaskTool({
      agentTypes: builtinAgentTypes(),
      model: subFake,
      onSubagentStart: (e) => { starts.push(e); },
    });
    const tc = createTestContext();
    const r = await handle.tool.execute(
      { agent_type: "general", task: "空白标题活", title: "   \n " },
      tc.ctx,
      tc.ctx.signal,
    );
    expect(resultPlainText(r.content)).not.toContain("title:");
    expect(starts[0]!.title).toBe("空白标题活");
  });

  it("后台显式 title：状态块 title 行（agent_type 前缀旧形不扰）+ 在飞册记录 + 账本 expected payload 三面同串", async () => {
    const { kernel, ledger, parent } = await bgHarness("夜检·W49.2");
    await parent.run("go");
    const trs = toolResults(parent);
    expect(trs[0]!.text).toContain("<task_metadata>\ntitle: 夜检·W49.2\nagent_type: general");
    // 既有精确前缀正则（task-background.test.ts 同形）逐字节仍绿 = additive 安全实锤。
    expect(trs[0]!.text).toMatch(/agent_type: general\nsession_id: ses_[0-9a-f]{16}\nreason: running\nturns: 0\ndepth: 1\ntask_id: run_/);
    await waitFor(() => kernel.subActiveCount() === 0);
    const rec = kernel.listSubRuns()[0]!;
    expect(rec.title).toBe("夜检·W49.2");
    const payload = ledger.entries[0]!.payload as Record<string, unknown>;
    expect(payload["title"]).toBe("夜检·W49.2");
  });

  it("后台缺省 title：derived（正文折叠前 40 码点）落册与账本，绝不 null", async () => {
    const { kernel, ledger, parent } = await bgHarness(); // task 正文=「后台取件活」
    await parent.run("go");
    await waitFor(() => kernel.subActiveCount() === 0);
    const rec = kernel.listSubRuns()[0]!;
    expect(rec.title).toBe("后台取件活");
    const payload = ledger.entries[0]!.payload as Record<string, unknown>;
    expect(payload["title"]).toBe("后台取件活");
    expect(toolResults(parent)[0]!.text).toContain("<task_metadata>\ntitle: 后台取件活\n");
  });
});
