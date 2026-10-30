/**
 * side-session-port 逐 run 绑定测试（B 面：角色自声明接线的端口侧）。
 * Given: 假模型脚本（converge 收束）+ resolveBinding 桩
 * When:  port.run(ctx)
 * Then:  绑定 systemPrompt 进首个 LLM context / 静态回落保留 / 解析失败走崩溃形状。
 */

import { describe, expect, it } from "vitest";

import { createFakeModel, type FakeAssistantResponse } from "../testing.js";
import { MemorySessionStore } from "../session-store.js";
import { createSideSessionPort } from "./side-session-port.js";
import type { RunLaunchContext, RunRow } from "./types.js";

const CONVERGE: FakeAssistantResponse = {
  content: [
    { type: "text", text: "正文。" },
    {
      type: "toolCall",
      name: "converge",
      arguments: { status: "done", runId: "x", workflow: "w", attempt: 1, digest: "done" },
    },
  ],
};

function ctx(agent?: string): RunLaunchContext {
  const row: RunRow = {
    run_id: "run_0123456789abcdef",
    workflow: "w",
    attempt: 1,
    trigger: "manual",
    parent_run: null,
    session_id: "ses_0123456789abcdef",
  };
  return { row, prompt: "任务正文", signal: new AbortController().signal, ...(agent === undefined ? {} : { agent }) };
}

describe("createSideSessionPort resolveBinding", () => {
  it("绑定给出的 systemPrompt 进入首个 LLM context（角色正文+注入块形状）", async () => {
    const model = createFakeModel([CONVERGE]);
    const port = createSideSessionPort({
      model,
      systemPrompt: "静态回落（应被覆盖）",
      resolveBinding: (c) =>
        Promise.resolve({
          systemPrompt: `# 角色\nagent=${c.agent ?? "none"}\n### memory[0] AGENTS.md\n稳定正文。\n`,
          memorySources: [],
          workspaceRoot: process.cwd(),
        }),
    });
    const result = await port.run(ctx("reviewer"));
    expect(result.status).toBe("done");
    const first = model.getCalls()[0];
    expect(first).toBeDefined();
    expect(first?.systemPrompt).toContain("# 角色");
    expect(first?.systemPrompt).toContain("agent=reviewer");
    expect(first?.systemPrompt).not.toContain("静态回落");
  });

  it("resolveBinding 缺省时静态 systemPrompt 原样生效（旧调用面零破坏）", async () => {
    const model = createFakeModel([CONVERGE]);
    const port = createSideSessionPort({ model, systemPrompt: "旧口径静态提示" });
    await port.run(ctx());
    expect(model.getCalls()[0]?.systemPrompt).toBe("旧口径静态提示");
  });

  it("绑定解析返回 error → 端口抛错（引擎崩溃形状的前提），不静默起会话", async () => {
    const model = createFakeModel([CONVERGE]);
    const port = createSideSessionPort({
      model,
      resolveBinding: () => Promise.resolve({ error: 'agent "ghost" 未定义' }),
    });
    await expect(port.run(ctx("ghost"))).rejects.toThrow(/ghost/);
    expect(model.getCalls()).toHaveLength(0); // 抛错在会话开火之前
  });

  it("挂 store：副会话转录按账本 session_id 落盘（user/assistant/toolResult + terminal），不挂 = 零写（W9 切片0）", async () => {
    const store = new MemorySessionStore();
    const model = createFakeModel([CONVERGE]);
    const port = createSideSessionPort({ model, systemPrompt: "旧口径静态提示", store });
    const result = await port.run(ctx());
    expect(result.status).toBe("done");

    const path = await store.getPathToLeaf("ses_0123456789abcdef");
    const messages = path
      .filter((e) => e.entry.kind === "message")
      .map((e) => (e.entry as { kind: "message"; message: { role: string } }).message);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(JSON.stringify(messages[0])).toContain("任务正文");
    expect(path.some((e) => e.entry.kind === "terminal")).toBe(true);

    // 未注入 store 的旧调用面：转录不落任何 store（端口零持久化写）。
    const bare = new MemorySessionStore();
    await createSideSessionPort({ model: createFakeModel([CONVERGE]) }).run(ctx());
    expect(await bare.getLeafId("ses_0123456789abcdef")).toBeNull();
  });
});
