/**
 * W16-F5 终态卫生 —— loom-main seq16/17 脏对的复现与钉死（Given/When/Then）：
 *   Given: provider error/abort 收尾时 resolved 出**零内容块** assistant（_phaseLlmCall 无条件 push）
 *   When:  该 run 落盘（_flushToStore/_persistTerminal）
 *   Then:  空 assistant 绝不进转录；terminal 恰一封；零增量空轮（abort 竞态双 flush 形状）不再重封。
 *
 * 探针取证（2026-10-10）：throwError 脚本 → store 曾现 `message:assistant:0:error` 脏行；
 * continue 空跑曾现第二条同 usage terminal。修复=落盘口剔除 + 封一幂等（水位 check→置位同步原子）。
 */

import { describe, expect, it } from "vitest";
import { AgentSession, MemorySessionStore } from "../index.js";
import { createFakeModel } from "../testing.js";

async function entryKinds(store: MemorySessionStore, sid: string): Promise<string[]> {
  return (await store.getPathToLeaf(sid)).map((n) => {
    const e = n.entry;
    if (e.kind === "message") {
      const m = e.message as { role: string; content: unknown };
      return `message:${m.role}:${typeof m.content === "string" ? "str" : (m.content as unknown[]).length}`;
    }
    return e.kind;
  });
}

describe("W16-F5 终态卫生", () => {
  it("provider error 收尾的空 assistant 不落盘：转录 = user + 恰一封 terminal", async () => {
    const store = new MemorySessionStore();
    const model = createFakeModel([
      { content: [{ type: "text", text: "x" }], throwError: new Error("provider exploded") },
    ]);
    // W42a stale pin（断言逐字不动）：钉单发错误终态的落盘卫生，显式禁重试。
    const s = new AgentSession({ model, tools: [], store, sessionId: "f5-empty", llmErrorRetries: 0 });

    const summary = await s.run("go");
    expect(summary.reason).toBe("error");

    const kinds = await entryKinds(store, "f5-empty");
    // 脏半修复钉：assistant:0 不再出现；内存契约不动（lastMessage 仍可由 summary 供证）。
    expect(kinds).toEqual(["message:user:str", "terminal"]);
    expect(summary.lastMessage?.role).toBe("assistant");
    expect(s.messages.some((m) => m.role === "assistant" && m.content.length === 0)).toBe(true);
    model.teardown();
  }, 15_000);

  it("封一幂等：正常 run+continue 各恰一封；零增量空轮（预 abort continue）不再重封", async () => {
    const store = new MemorySessionStore();
    const model = createFakeModel([
      { content: [{ type: "text", text: "第一段" }] },
      { content: [{ type: "text", text: "第二段" }] },
    ]);
    const s = new AgentSession({ model, tools: [], store, sessionId: "f5-seal" });

    await s.run("go1");
    await s.continue();
    const afterTwo = await entryKinds(store, "f5-seal");
    expect(afterTwo).toEqual([
      "message:user:str",
      "message:assistant:1",
      "terminal",
      "message:assistant:1",
      "terminal",
    ]);

    // 零增量空轮：水位未动 → 同水位重封被幂等闸吞掉（abort 竞态双 flush 防御面）。
    const ctrl = new AbortController();
    ctrl.abort();
    await s.continue({ signal: ctrl.signal });
    const afterThree = await entryKinds(store, "f5-seal");
    expect(afterThree.filter((k) => k === "terminal")).toHaveLength(2);
    model.teardown();
  }, 15_000);
});
