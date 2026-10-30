/**
 * W11a3 task_fetch 单测 —— 三档投影/头部状态行/截断/不存在 sid/参数校验。
 * Given: MemorySessionStore 构造 entry 序列（message/terminal 混排，toolCall/toolResult 齐活）
 * When:  直调 tool.execute 各档参数
 * Then:  full 逐条渲染含 toolCall(名+略截)/toolResult(名+略截)；clean 仅 user/assistant 文本
 *        （剔 toolCall/thinking/toolResult）；tail = clean 末 count 条（缺省 8）；
 *        头部恒 "sid 存在|不存在；条目数 N"；max_chars 超限截断加标记行；坏参数 fail-loud。
 */

import { describe, expect, it } from "vitest";
import {
  MemorySessionStore,
  type HookContext,
  type Message,
  type SessionEntry,
  type ToolExecResult,
} from "@axeuh/loom-core";

import { createTaskFetchTool } from "./task-fetch.js";

const SID = "ses_aaaaaaaaaaaaaaaa";
const ctx = { sessionId: "ses_caller_main_00000" } as unknown as HookContext;
const sig = new AbortController().signal;

type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

function msgEntry(m: Message): SessionEntry {
  return { kind: "message", message: m };
}
function userEntry(text: string): SessionEntry {
  return msgEntry({ role: "user", content: text, timestamp: 0 } as Message);
}
function userBlocksEntry(content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>): SessionEntry {
  return msgEntry({ role: "user", content, timestamp: 0 } as unknown as Message);
}
function asstEntry(blocks: AssistantBlock[]): SessionEntry {
  return msgEntry({
    role: "assistant",
    content: blocks,
    api: "fake",
    provider: "fake",
    model: "fake",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
  } as unknown as Message);
}
function trEntry(toolName: string, text: string): SessionEntry {
  return msgEntry({
    role: "toolResult",
    toolCallId: `tc_${toolName}`,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  } as unknown as Message);
}

/** 标准四步转录 + 一条 terminal（计入条目数、不进投影）。 */
async function seedStandard(store: MemorySessionStore, sid = SID): Promise<void> {
  await store.appendEntry(sid, userEntry("只读回答：1+1=几"));
  await store.appendEntry(sid, asstEntry([
    { type: "text", text: "先算一下。" },
    { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "echo $((1+1))" } },
  ]));
  await store.appendEntry(sid, trEntry("bash", "2"));
  await store.appendEntry(sid, asstEntry([{ type: "text", text: "答案：1+1=2。" }]));
  await store.appendEntry(sid, { kind: "terminal", result: {} } as unknown as SessionEntry);
}

function resultText(r: ToolExecResult): string {
  const block = r.content[0];
  expect(block?.type).toBe("text");
  return block && block.type === "text" ? block.text : "";
}

describe("task_fetch：三档投影", () => {
  it("clean（缺省档）：仅 user/assistant 文本，剔 toolCall/thinking/toolResult；头部含状态行与条目数", async () => {
    const store = new MemorySessionStore();
    await seedStandard(store);
    const tool = createTaskFetchTool({ store });

    const text = resultText(await tool.execute({ session_id: SID }, ctx, sig));
    expect(text.startsWith("sid 存在；条目数 5\n\n")).toBe(true);
    expect(text).toContain("user: 只读回答：1+1=几");
    expect(text).toContain("assistant: 先算一下。");
    expect(text).toContain("assistant: 答案：1+1=2。");
    expect(text).not.toContain("toolCall");
    expect(text).not.toContain("toolResult");
    expect(text).not.toContain("echo $((1+1))");
  });

  it("clean：assistant 仅含 toolCall/thinking（无文本）→ 整条剔除", async () => {
    const store = new MemorySessionStore();
    await store.appendEntry(SID, userEntry("任务正文"));
    await store.appendEntry(SID, asstEntry([
      { type: "thinking", thinking: "内部想法不该出现在 clean" },
      { type: "toolCall", id: "t", name: "read", arguments: { path: "a.md" } },
    ]));
    await store.appendEntry(SID, asstEntry([{ type: "text", text: "最终回答" }]));
    const tool = createTaskFetchTool({ store });

    const text = resultText(await tool.execute({ session_id: SID, mode: "clean" }, ctx, sig));
    expect(text).toContain("user: 任务正文");
    expect(text).toContain("assistant: 最终回答");
    expect(text).not.toContain("内部想法");
    expect(text).not.toContain("read");
    // 条目数 3、投影 2 行 → 头部+两行 = 三段
    expect(text.split("\n\n").length).toBe(3);
  });

  it("full：全部 message 条目逐条渲染，含 toolCall(名+紧凑参数略截) 与 toolResult(名+输出略截)", async () => {
    const store = new MemorySessionStore();
    await seedStandard(store);
    const tool = createTaskFetchTool({ store });

    const text = resultText(await tool.execute({ session_id: SID, mode: "full" }, ctx, sig));
    expect(text).toContain("user: 只读回答：1+1=几");
    expect(text).toContain("toolCall bash(command=echo $((1+1)))");
    expect(text).not.toContain('{"command"');
    expect(text).toContain("toolResult bash: 2");
    expect(text).toContain("assistant: 答案：1+1=2。");
    expect(text).not.toContain("terminal"); // terminal 条目计数但不渲染
  });

  it("full：参数渲染为紧凑 key=value（数组逗号、嵌套对象括号、多行压平）", async () => {
    const store = new MemorySessionStore();
    await store.appendEntry(SID, userEntry("参数形态"));
    await store.appendEntry(SID, asstEntry([
      {
        type: "toolCall",
        id: "t",
        name: "demo",
        arguments: { flags: ["a", "b"], options: { x: 1 }, text: "line1\nline2" },
      },
    ]));
    const tool = createTaskFetchTool({ store });

    const text = resultText(await tool.execute({ session_id: SID, mode: "full" }, ctx, sig));
    expect(text).toContain("flags=a,b");
    expect(text).toContain("options=(x=1)");
    expect(text).toContain("text=line1 line2");
    expect(text).not.toContain("line1\nline2");
    expect(text).not.toContain("{");
  });

  it("full：数组元素为对象/嵌套数组时递归渲染（不出现 [object Object]）", async () => {
    const store = new MemorySessionStore();
    await store.appendEntry(SID, userEntry("数组对象参数"));
    await store.appendEntry(SID, asstEntry([
      {
        type: "toolCall",
        id: "t",
        name: "plan_diff",
        arguments: { ops: [{ op: "update", id: "x", patch: { at: "06:30" } }], matrix: [[1, 2], [3, 4]] },
      },
    ]));
    const tool = createTaskFetchTool({ store });

    const text = resultText(await tool.execute({ session_id: SID, mode: "full" }, ctx, sig));
    expect(text).toContain("ops=(op=update, id=x, patch=(at=06:30))");
    expect(text).toContain("matrix=1,2,3,4");
    expect(text).not.toContain("[object Object]");
  });

  it("full：超长工具参数/输出走内嵌略截（不吞掉其余条目）", async () => {
    const store = new MemorySessionStore();
    const big = "x".repeat(900);
    await store.appendEntry(SID, userEntry("大输出转录"));
    await store.appendEntry(SID, asstEntry([{ type: "toolCall", id: "t", name: "write", arguments: { content: big } }]));
    await store.appendEntry(SID, trEntry("write", big));
    await store.appendEntry(SID, asstEntry([{ type: "text", text: "收尾行" }]));
    const tool = createTaskFetchTool({ store });

    const text = resultText(await tool.execute({ session_id: SID, mode: "full" }, ctx, sig));
    expect(text).toContain("toolCall write(");
    expect(text).toContain("…(+");
    expect(text).not.toContain(big);
    expect(text).toContain("收尾行"); // 略截后末条仍完整在场
  });

  it("tail：clean 末 count 条；缺省 8 条", async () => {
    const store = new MemorySessionStore();
    for (let i = 1; i <= 11; i++) {
      await store.appendEntry(SID, userEntry(`序号${String(i).padStart(2, "0")}条目`));
    }
    const tool = createTaskFetchTool({ store });

    const t3 = resultText(await tool.execute({ session_id: SID, mode: "tail", count: 3 }, ctx, sig));
    expect(t3).toContain("序号11");
    expect(t3).toContain("序号09");
    expect(t3).not.toContain("序号08");

    const tDef = resultText(await tool.execute({ session_id: SID, mode: "tail" }, ctx, sig));
    expect(tDef).toContain("序号11");
    expect(tDef).toContain("序号04"); // 末 8 条 = 04..11
    expect(tDef).not.toContain("序号03");
  });

  it("user image 块打占位、text 块拼接（投影共用底座）", async () => {
    const store = new MemorySessionStore();
    await store.appendEntry(SID, userBlocksEntry([
      { type: "text", text: "看图：" },
      { type: "image", data: "Zm9v", mimeType: "image/png" },
    ]));
    const tool = createTaskFetchTool({ store });
    const text = resultText(await tool.execute({ session_id: SID }, ctx, sig));
    expect(text).toContain("user: 看图： [image omitted]");
  });
});

describe("task_fetch：状态行/截断/不存在 sid", () => {
  it("不存在 sid：首行 'sid 不存在；条目数 0'，正常返回（非 isError、不抛）", async () => {
    const store = new MemorySessionStore();
    await seedStandard(store);
    const tool = createTaskFetchTool({ store });

    const r = await tool.execute({ session_id: "ses_nosuchsid0000000" }, ctx, sig);
    expect(r.isError).toBeUndefined();
    expect(resultText(r).startsWith("sid 不存在；条目数 0")).toBe(true);
  });

  it("max_chars 超限：正文截断 + 标记行，头部状态行受保护恒在最前", async () => {
    const store = new MemorySessionStore();
    await store.appendEntry(SID, userEntry("L".repeat(400)));
    await store.appendEntry(SID, userEntry("R".repeat(400)));
    const tool = createTaskFetchTool({ store });

    const head = "sid 存在；条目数 2\n\n";
    const budget = 200 - head.length;
    const body = "user: " + "L".repeat(400) + "\n\n" + "user: " + "R".repeat(400);
    const text = resultText(await tool.execute({ session_id: SID, mode: "clean", max_chars: 200 }, ctx, sig));
    expect(text.startsWith(head + body.slice(0, budget))).toBe(true);
    expect(text).toContain("[task_fetch: 输出超 max_chars=200");
    expect(text).toContain(`省略 ${body.length - budget} 字符`);
    expect(text).not.toContain("R".repeat(50));
  });

  it("空投影（toolResult-only 会话，clean 档）：给 '无符合该投影形态的正文条目' 而非空串", async () => {
    const store = new MemorySessionStore();
    await store.appendEntry(SID, trEntry("bash", "只有一条工具结果"));
    const tool = createTaskFetchTool({ store });
    const text = resultText(await tool.execute({ session_id: SID, mode: "clean" }, ctx, sig));
    expect(text).toContain("sid 存在；条目数 1");
    expect(text).toContain("(无符合该投影形态的正文条目)");
  });
});

describe("task_fetch：参数 fail-loud", () => {
  const tool = createTaskFetchTool({ store: new MemorySessionStore() });

  it("session_id 非 ses_ 前缀 / 缺失 → 抛错", async () => {
    await expect(tool.execute({ session_id: "main_1" }, ctx, sig)).rejects.toThrow(/must start with "ses_"/);
    await expect(tool.execute({}, ctx, sig)).rejects.toThrow(/must start with "ses_"/);
  });

  it("mode 非三档枚举 → 抛错（不静默回落缺省）", async () => {
    await expect(tool.execute({ session_id: SID, mode: "bogus" }, ctx, sig)).rejects.toThrow(/mode must be one of full\|clean\|tail/);
  });

  it("count / max_chars 非正有限数 → 抛错", async () => {
    await expect(tool.execute({ session_id: SID, mode: "tail", count: 0 }, ctx, sig)).rejects.toThrow(/count must be a finite number >= 1/);
    await expect(tool.execute({ session_id: SID, max_chars: -5 }, ctx, sig)).rejects.toThrow(/max_chars must be a finite number >= 1/);
    await expect(tool.execute({ session_id: SID, count: Number.NaN }, ctx, sig)).rejects.toThrow(/count/);
  });
});

describe("task_fetch：只读纪律", () => {
  it("取件不改写 store：前后 getPathToLeaf 逐字节等、leaf 不推进；不存在 sid 不被误建", async () => {
    const store = new MemorySessionStore();
    await seedStandard(store);
    const before = await store.getPathToLeaf(SID);
    const leafBefore = await store.getLeafId(SID);
    const tool = createTaskFetchTool({ store });

    await tool.execute({ session_id: SID, mode: "full" }, ctx, sig);
    await tool.execute({ session_id: SID, mode: "tail", count: 2 }, ctx, sig);
    await tool.execute({ session_id: "ses_never_seen_000000" }, ctx, sig);

    const after = await store.getPathToLeaf(SID);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(await store.getLeafId(SID)).toBe(leafBefore);
    expect(await store.getLeafId("ses_never_seen_000000")).toBeNull();
  });
});
