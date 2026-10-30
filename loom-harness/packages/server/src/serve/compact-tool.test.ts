/**
 * compact_context 工具面（W57 P4）—— 手动压缩启动参数钉。
 * Given: 只提供 startCompaction 的 fake session + 末条为 user 的 ctx.messages。
 * When:  直接执行工具 execute。
 * Then:  ①恰以单参 "tool" 启动（worker 从 live boundary 的 coveredCount 起算，与
 *        POST /sessions/:id/compact 手动入口同谱，末条 user 绝不充当 floor）；
 *        ②回执文本带 attempt id；③session 不可用 = 明确报错。
 */

import { describe, expect, it, vi } from "vitest";

import { createUserMessage } from "@axeuh/loom-core";
import type { AgentSession, HookContext } from "@axeuh/loom-core";

import { createCompactContextTool } from "./compact-tool.js";

function fakeCtx(
  messages: HookContext["messages"],
  sessionId = "ses-1",
): HookContext {
  return { sessionId, messages } as unknown as HookContext;
}

function fakeSession(attemptId = "attempt-42") {
  const startCompaction = vi.fn(() => ({
    attemptId,
    done: Promise.resolve({}),
  }));
  const session = { startCompaction } as unknown as AgentSession;
  return { session, startCompaction };
}

const signal = new AbortController().signal;

describe("compact_context：手动压缩只以 reason 启动 worker", () => {
  it("末条是 user 时也不传 floor：startCompaction 恰收一个参数 \"tool\"", async () => {
    const { session, startCompaction } = fakeSession();
    const tool = createCompactContextTool({ resolveSession: () => session });
    await tool.execute({}, fakeCtx([createUserMessage("旧"), createUserMessage("最新")]), signal);
    expect(startCompaction).toHaveBeenCalledTimes(1);
    expect(startCompaction).toHaveBeenCalledWith("tool");
    expect(startCompaction.mock.calls[0]).toHaveLength(1);
  });

  it("回执文本 = Compaction started (attempt <id>).", async () => {
    const { session } = fakeSession("attempt-7");
    const tool = createCompactContextTool({ resolveSession: () => session });
    const result = await tool.execute({}, fakeCtx([]), signal);
    expect(result).toEqual({
      content: [{ type: "text", text: "Compaction started (attempt attempt-7)." }],
    });
  });

  it("session 不可用：抛出点名 session 的明确错误", async () => {
    const tool = createCompactContextTool({ resolveSession: () => undefined });
    await expect(
      tool.execute({}, fakeCtx([], "ses-missing"), signal),
    ).rejects.toThrow("compact_context: session ses-missing is not available");
  });
});
